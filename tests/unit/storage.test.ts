/**
 * Storage (T-047).
 *
 * Two things are being proved here, and they need different tools.
 *
 * **That the fallback is not a lesser store.** F10 says a visitor in private
 * browsing gets the in-memory repository, silently. That is only acceptable if
 * the two implementations behave identically, so the conformance suite below is
 * written once and run against both. If a copy-on-read is added to one and not
 * the other, it goes red.
 *
 * **That nothing about storage can break the page.** Missing IndexedDB, an
 * `open()` that throws, an open request that errors, another tab blocking the
 * upgrade — each has to end in a working repository, not an exception.
 *
 * ## The fake
 *
 * These run under Node, which has no IndexedDB, and the project ships zero
 * dependencies it does not need (plan §13) — so `fake-indexeddb` is not an
 * option and the fake below is hand-rolled. It is deliberately awkward in the
 * ways the real thing is awkward: requests settle asynchronously through
 * `queueMicrotask` with `onsuccess`/`onerror` handlers attached after the
 * request object is returned, `onupgradeneeded` fires before `onsuccess` and
 * only on a version increase, transactions commit through `oncomplete` after
 * every request in them has settled, a failed request aborts its transaction,
 * a read-only transaction refuses to write, and values are structured-cloned on
 * the way in and out. Data outlives the connection, which is what makes
 * "open, seed, reopen" a real test of idempotence rather than a restatement of
 * it. What it does not model: cursors, key ranges, indexes as anything but a
 * name, and the auto-commit rule that closes a transaction when the event loop
 * yields.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Booking } from '../../src/engine/index.js';
import type { BookingRepository, Transcript } from '../../src/agent/ports.js';
import { STORAGE } from '../../src/config/settings.js';
import { buildSeedDiary } from '../../src/config/seed.js';
import { createIndexedDbRepository } from '../../src/storage/indexeddb.js';
import { createMemoryRepository } from '../../src/storage/memory.js';
import { openRepository } from '../../src/storage/repository.js';
import { CONFIG, NOW_ISO, TODAY } from '../helpers/engine.js';

/* ------------------------------------------------------------- the fake -- */

interface StoredStore {
  readonly keyPath: string;
  readonly rows: Map<string, unknown>;
  readonly indexes: Set<string>;
}

interface StoredDatabase {
  version: number;
  readonly stores: Map<string, StoredStore>;
}

/** Survives connections being closed, the way a real origin's storage does. */
const databases = new Map<string, StoredDatabase>();

/** Set by `failNextRequest`; consumed by the first matching operation. */
let pendingFailure: { readonly op: string; readonly message: string } | null = null;

function failNextRequest(op: 'put' | 'getAll' | 'clear', message = 'simulated failure'): void {
  pendingFailure = { op, message };
}

function takeFailure(op: string): string | null {
  if (pendingFailure === null || pendingFailure.op !== op) return null;
  const { message } = pendingFailure;
  pendingFailure = null;
  return message;
}

type Handler = (() => void) | null;

interface FakeRequest<T> {
  result: T;
  error: { name: string; message: string } | null;
  onsuccess: Handler;
  onerror: Handler;
}

class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  error: { name: string; message: string } | null = null;

  private pending = 0;
  private settled = false;
  private aborted = false;

  constructor(
    private readonly db: StoredDatabase,
    readonly mode: 'readonly' | 'readwrite' | 'versionchange',
  ) {}

  objectStore(name: string): FakeObjectStore {
    const data = this.db.stores.get(name);
    if (data === undefined) throw new Error(`NotFoundError: no object store named ${name}`);
    return new FakeObjectStore(data, this);
  }

  /** Queue one request. Nothing resolves in the caller's tick, exactly as in a browser. */
  schedule<T>(op: string, work: () => T): FakeRequest<T> {
    const request: FakeRequest<T> = {
      result: undefined as unknown as T,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    this.pending += 1;
    queueMicrotask(() => {
      const failure = takeFailure(op);
      try {
        if (failure !== null) throw new Error(failure);
        request.result = work();
        request.onsuccess?.();
      } catch (cause) {
        request.error = { name: 'FakeError', message: String(cause) };
        this.aborted = true;
        request.onerror?.();
      }
      this.pending -= 1;
      // A tick later, so a caller issuing two requests back to back does not
      // see the transaction commit between them.
      queueMicrotask(() => {
        this.commit();
      });
    });
    return request;
  }

  private commit(): void {
    if (this.settled || this.pending > 0) return;
    this.settled = true;
    if (this.aborted) {
      this.error = { name: 'AbortError', message: 'transaction aborted' };
      this.onabort?.();
      return;
    }
    this.oncomplete?.();
  }
}

class FakeObjectStore {
  constructor(
    private readonly data: StoredStore,
    private readonly tx: FakeTransaction,
  ) {}

  get indexNames(): { contains(name: string): boolean } {
    const { indexes } = this.data;
    return { contains: (name: string): boolean => indexes.has(name) };
  }

  createIndex(name: string, keyPath: string): unknown {
    if (this.tx.mode !== 'versionchange') throw new Error('InvalidStateError: indexes need an upgrade');
    this.data.indexes.add(name);
    return { name, keyPath };
  }

  put(value: unknown): FakeRequest<unknown> {
    this.requireWritable();
    return this.tx.schedule('put', () => {
      const key = (value as Record<string, unknown>)[this.data.keyPath];
      if (typeof key !== 'string') throw new Error(`DataError: no ${this.data.keyPath}`);
      this.data.rows.set(key, structuredClone(value));
      return undefined;
    });
  }

  getAll(): FakeRequest<unknown[]> {
    return this.tx.schedule('getAll', () =>
      Array.from(this.data.rows.values(), (row) => structuredClone(row)),
    );
  }

  clear(): FakeRequest<unknown> {
    this.requireWritable();
    return this.tx.schedule('clear', () => {
      this.data.rows.clear();
      return undefined;
    });
  }

  private requireWritable(): void {
    if (this.tx.mode === 'readonly') throw new Error('ReadOnlyError: transaction is read-only');
  }
}

class FakeConnection {
  onversionchange: Handler = null;
  /** Non-null only while `onupgradeneeded` is running. */
  upgradeTx: FakeTransaction | null = null;
  private closed = false;

  constructor(private readonly db: StoredDatabase) {}

  get objectStoreNames(): { contains(name: string): boolean } {
    const { stores } = this.db;
    return { contains: (name: string): boolean => stores.has(name) };
  }

  createObjectStore(name: string, options: { keyPath: string }): FakeObjectStore {
    const tx = this.upgradeTx;
    if (tx === null) throw new Error('InvalidStateError: createObjectStore outside an upgrade');
    const data: StoredStore = { keyPath: options.keyPath, rows: new Map(), indexes: new Set() };
    this.db.stores.set(name, data);
    return new FakeObjectStore(data, tx);
  }

  transaction(names: string[], mode: 'readonly' | 'readwrite'): FakeTransaction {
    if (this.closed) throw new Error('InvalidStateError: connection is closed');
    for (const name of names) {
      if (!this.db.stores.has(name)) throw new Error(`NotFoundError: no object store named ${name}`);
    }
    return new FakeTransaction(this.db, mode);
  }

  close(): void {
    this.closed = true;
  }
}

interface FakeOpenRequest extends FakeRequest<FakeConnection> {
  transaction: FakeTransaction | null;
  onupgradeneeded: Handler;
  onblocked: Handler;
}

function fakeFactory(): { open(name: string, version: number): FakeOpenRequest } {
  return {
    open(name: string, version: number): FakeOpenRequest {
      const request: FakeOpenRequest = {
        result: undefined as unknown as FakeConnection,
        error: null,
        transaction: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      };

      queueMicrotask(() => {
        let stored = databases.get(name);
        if (stored === undefined) {
          stored = { version: 0, stores: new Map() };
          databases.set(name, stored);
        }
        const connection = new FakeConnection(stored);
        request.result = connection;

        if (version > stored.version) {
          const tx = new FakeTransaction(stored, 'versionchange');
          stored.version = version;
          connection.upgradeTx = tx;
          request.transaction = tx;
          try {
            request.onupgradeneeded?.();
          } catch (cause) {
            request.error = { name: 'FakeError', message: String(cause) };
            request.onerror?.();
            return;
          } finally {
            connection.upgradeTx = null;
            request.transaction = null;
          }
        }
        request.onsuccess?.();
      });

      return request;
    },
  };
}

function installIndexedDb(factory: unknown): void {
  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true, writable: true });
}

function removeIndexedDb(): void {
  Reflect.deleteProperty(globalThis, 'indexedDB');
}

/* ----------------------------------------------------------- fixtures -- */

function makeBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'b-1',
    reference: 'QT4RM',
    date: '2026-08-28',
    time: '19:00',
    partySize: 4,
    name: 'Karani',
    phone: '9820044471',
    tableId: 'T4',
    durationMinutes: 105,
    createdAt: NOW_ISO,
    source: 'voice',
    brain: 'llm',
    outcome: 'booked',
    seeded: false,
    ...overrides,
  };
}

function makeTranscript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    id: 't-1',
    bookingId: 'b-1',
    startedAt: NOW_ISO,
    locale: 'en-IN',
    turns: [
      { role: 'agent', text: 'Ember and Oak, how can I help?', at: NOW_ISO },
      {
        role: 'visitor',
        text: 'table for four on Friday',
        at: NOW_ISO,
        brain: 'llm',
        slotDelta: { partySize: '4' },
        rejected: [{ reason: 'date_in_past', detail: 'that date has gone by' }],
      },
    ],
    outcome: 'booked',
    latencies: [820, 640],
    ...overrides,
  };
}

/** `noUncheckedIndexedAccess` means every row lookup needs this. */
function only<T>(rows: readonly T[]): T {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) throw new Error('expected exactly one row');
  return row;
}

const seedDiary = (): readonly Booking[] => buildSeedDiary(CONFIG, TODAY, NOW_ISO);

beforeEach(() => {
  databases.clear();
  pendingFailure = null;
  installIndexedDb(fakeFactory());
});

afterEach(() => {
  removeIndexedDb();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------- conformance -- */

/**
 * The same assertions against both implementations.
 *
 * The fallback exists to be indistinguishable. Anything asserted here of one
 * store must hold of the other, or F10 is a downgrade the visitor was never
 * told about.
 */
function describeRepository(label: string, open: () => Promise<BookingRepository>): void {
  describe(`${label} repository`, () => {
    it('starts empty', async () => {
      const repository = await open();
      expect(await repository.listBookings()).toEqual([]);
      expect(await repository.listTranscripts()).toEqual([]);
    });

    it('saves a booking and lists it back intact', async () => {
      const repository = await open();
      const booking = makeBooking();
      await repository.saveBooking(booking);
      expect(only(await repository.listBookings())).toEqual(booking);
    });

    it('replaces a booking with the same id rather than appending', async () => {
      const repository = await open();
      await repository.saveBooking(makeBooking());
      await repository.saveBooking(makeBooking({ time: '20:15' }));
      expect(only(await repository.listBookings()).time).toBe('20:15');
    });

    it('keeps distinct bookings apart', async () => {
      const repository = await open();
      await repository.saveBooking(makeBooking({ id: 'b-1' }));
      await repository.saveBooking(makeBooking({ id: 'b-2' }));
      const ids = (await repository.listBookings()).map((b) => b.id).sort();
      expect(ids).toEqual(['b-1', 'b-2']);
    });

    it('round-trips a transcript, nested turns and rejections included', async () => {
      const repository = await open();
      const transcript = makeTranscript();
      await repository.saveTranscript(transcript);
      expect(only(await repository.listTranscripts())).toEqual(transcript);
    });

    it('clear wipes both stores', async () => {
      const repository = await open();
      await repository.saveBooking(makeBooking());
      await repository.saveTranscript(makeTranscript());
      await repository.clear();
      expect(await repository.listBookings()).toEqual([]);
      expect(await repository.listTranscripts()).toEqual([]);
    });

    it('hands out copies, so a caller mutating a result cannot corrupt the store', async () => {
      const repository = await open();
      await repository.saveBooking(makeBooking({ name: 'Karani' }));

      const returned = only(await repository.listBookings());
      (returned as unknown as { name: string }).name = 'Tampered';
      (returned as unknown as { partySize: number }).partySize = 99;

      const again = only(await repository.listBookings());
      expect(again.name).toBe('Karani');
      expect(again.partySize).toBe(4);
    });

    it('copies on write, so mutating the argument afterwards changes nothing', async () => {
      const repository = await open();
      const booking = makeBooking({ name: 'Karani' });
      await repository.saveBooking(booking);
      (booking as unknown as { name: string }).name = 'Tampered';
      expect(only(await repository.listBookings()).name).toBe('Karani');
    });

    it('deep-copies nested transcript turns too', async () => {
      const repository = await open();
      await repository.saveTranscript(makeTranscript());

      const returned = only(await repository.listTranscripts());
      const turn = returned.turns[0];
      if (turn === undefined) throw new Error('expected a turn');
      (turn as unknown as { text: string }).text = 'Tampered';

      const again = only(await repository.listTranscripts());
      expect(again.turns[0]?.text).toBe('Ember and Oak, how can I help?');
    });
  });
}

describeRepository('memory', async () => {
  const repository = createMemoryRepository();
  await repository.init();
  expect(repository.kind).toBe('memory');
  expect(repository.persistent).toBe(false);
  return repository;
});

describeRepository('indexeddb', async () => {
  const repository = createIndexedDbRepository();
  await repository.init();
  expect(repository.kind).toBe('indexeddb');
  expect(repository.persistent).toBe(true);
  return repository;
});

/* ---------------------------------------------------- indexeddb schema -- */

describe('indexeddb schema', () => {
  it('creates both stores keyed by id, and the date index, on a fresh database', async () => {
    const repository = createIndexedDbRepository();
    await repository.init();

    const stored = databases.get(STORAGE.dbName);
    expect(stored?.version).toBe(STORAGE.dbVersion);
    expect(stored?.stores.get(STORAGE.bookingStore)?.keyPath).toBe('id');
    expect(stored?.stores.get(STORAGE.transcriptStore)?.keyPath).toBe('id');
    expect(stored?.stores.get(STORAGE.bookingStore)?.indexes.has('by-date')).toBe(true);
  });

  it('adds what is missing on a version bump without dropping existing rows', async () => {
    // A database from an earlier version: the bookings store exists, with a
    // row in it, but neither the index nor the transcripts store does.
    databases.set(STORAGE.dbName, {
      version: 0,
      stores: new Map([
        [
          STORAGE.bookingStore,
          { keyPath: 'id', rows: new Map<string, unknown>([['b-1', makeBooking()]]), indexes: new Set<string>() },
        ],
      ]),
    });

    const repository = createIndexedDbRepository();
    await repository.init();

    const stored = databases.get(STORAGE.dbName);
    expect(stored?.stores.get(STORAGE.bookingStore)?.indexes.has('by-date')).toBe(true);
    expect(stored?.stores.has(STORAGE.transcriptStore)).toBe(true);
    expect(only(await repository.listBookings()).id).toBe('b-1');
  });

  it('survives the connection being replaced, which is what persistent means', async () => {
    const first = createIndexedDbRepository();
    await first.init();
    await first.saveBooking(makeBooking());

    const second = createIndexedDbRepository();
    await second.init();
    expect(only(await second.listBookings()).id).toBe('b-1');
  });
});

/* ------------------------------------------------- indexeddb degrading -- */

describe('indexeddb degrades rather than throws', () => {
  it('returns an empty list when a read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repository = createIndexedDbRepository();
    await repository.init();
    await repository.saveBooking(makeBooking());

    failNextRequest('getAll');
    expect(await repository.listBookings()).toEqual([]);
    expect(warn).toHaveBeenCalled();

    // The row is still there; only the one read failed.
    expect(await repository.listBookings()).toHaveLength(1);
  });

  it('swallows a failed write, because saveBooking has no way to report one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repository = createIndexedDbRepository();
    await repository.init();

    failNextRequest('put');
    await expect(repository.saveBooking(makeBooking())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(await repository.listBookings()).toEqual([]);
  });

  it('swallows a failed clear', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repository = createIndexedDbRepository();
    await repository.init();
    await repository.saveBooking(makeBooking());

    failNextRequest('clear');
    await expect(repository.clear()).resolves.toBeUndefined();
  });

  it('is inert rather than explosive when used before init', async () => {
    const repository = createIndexedDbRepository();
    await expect(repository.saveBooking(makeBooking())).resolves.toBeUndefined();
    await expect(repository.listBookings()).resolves.toEqual([]);
    await expect(repository.listTranscripts()).resolves.toEqual([]);
    await expect(repository.clear()).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------- F10 fallback -- */

describe('openRepository falls back to memory (F10)', () => {
  async function expectMemoryFallback(): Promise<void> {
    const repository = await openRepository();
    expect(repository.kind).toBe('memory');
    expect(repository.persistent).toBe(false);
    // And it is a working store, not a stub.
    await repository.saveBooking(makeBooking());
    expect(await repository.listBookings()).toHaveLength(1);
  }

  it('when the environment has no IndexedDB at all', async () => {
    removeIndexedDb();
    await expectMemoryFallback();
  });

  it('when indexedDB is present but not a factory', async () => {
    installIndexedDb({ open: 'not a function' });
    await expectMemoryFallback();
  });

  it('when open() throws synchronously, as private mode once did', async () => {
    installIndexedDb({
      open(): never {
        throw new Error('SecurityError: the operation is insecure');
      },
    });
    await expectMemoryFallback();
  });

  it('when the open request fires onerror', async () => {
    installIndexedDb({
      open(): FakeOpenRequest {
        const request = { ...blankOpenRequest() };
        queueMicrotask(() => {
          request.error = { name: 'QuotaExceededError', message: 'no room' };
          request.onerror?.();
        });
        return request;
      },
    });
    await expectMemoryFallback();
  });

  it('when the open request errors with no error object attached', async () => {
    installIndexedDb({
      open(): FakeOpenRequest {
        const request = { ...blankOpenRequest() };
        queueMicrotask(() => {
          request.onerror?.();
        });
        return request;
      },
    });
    await expectMemoryFallback();
  });

  it('when another tab blocks the upgrade', async () => {
    installIndexedDb({
      open(): FakeOpenRequest {
        const request = { ...blankOpenRequest() };
        queueMicrotask(() => {
          request.onblocked?.();
        });
        return request;
      },
    });
    await expectMemoryFallback();
  });

  it('when the caller asks for memory outright', async () => {
    const repository = await openRepository({ forceMemory: true });
    expect(repository.kind).toBe('memory');
  });

  it('but uses IndexedDB when IndexedDB works', async () => {
    const repository = await openRepository();
    expect(repository.kind).toBe('indexeddb');
    expect(repository.persistent).toBe(true);
  });

  it('seeds the fallback store too, so private browsing still gets a diary', async () => {
    removeIndexedDb();
    const repository = await openRepository({ seed: seedDiary });
    expect(await repository.listBookings()).toHaveLength(seedDiary().length);
  });
});

function blankOpenRequest(): FakeOpenRequest {
  return {
    result: undefined as unknown as FakeConnection,
    error: null,
    transaction: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
    onblocked: null,
  };
}

/* ---------------------------------------------------------- seeding -- */

describe('first-load seeding (§10.6)', () => {
  it('inserts the demo diary on first open', async () => {
    const repository = await openRepository({ seed: seedDiary });
    const bookings = await repository.listBookings();
    expect(bookings).toHaveLength(seedDiary().length);
    expect(bookings.every((b) => b.seeded)).toBe(true);
  });

  it('does not duplicate the diary when the page is opened again', async () => {
    const first = await openRepository({ seed: seedDiary });
    const before = (await first.listBookings()).length;
    expect(before).toBeGreaterThan(0);

    // The connection is discarded; the database is not. Reopening is exactly
    // what a refresh does.
    const second = await openRepository({ seed: seedDiary });
    expect(await second.listBookings()).toHaveLength(before);
  });

  it('does not duplicate it after many opens', async () => {
    let count = 0;
    for (let open = 0; open < 4; open += 1) {
      const repository = await openRepository({ seed: seedDiary });
      count = (await repository.listBookings()).length;
    }
    expect(count).toBe(seedDiary().length);
  });

  it('does not run when the store already holds a booking', async () => {
    const existing = createIndexedDbRepository();
    await existing.init();
    await existing.saveBooking(makeBooking({ id: 'visitor-1', seeded: false }));

    const repository = await openRepository({ seed: seedDiary });
    const bookings = await repository.listBookings();
    expect(bookings).toHaveLength(1);
    expect(only(bookings).id).toBe('visitor-1');
  });

  it('does nothing at all when no seed is supplied', async () => {
    const repository = await openRepository();
    expect(await repository.listBookings()).toEqual([]);
  });

  it('re-seeds after the diary is cleared, so the demo is never a blank screen', async () => {
    const first = await openRepository({ seed: seedDiary });
    await first.clear();
    expect(await first.listBookings()).toEqual([]);

    const second = await openRepository({ seed: seedDiary });
    expect(await second.listBookings()).toHaveLength(seedDiary().length);
  });

  it('writes seed rows under stable ids, which is the second guard against doubling', async () => {
    const rows = seedDiary();
    const ids = new Set(rows.map((row) => row.id));
    expect(ids.size).toBe(rows.length);
    expect(seedDiary().map((row) => row.id)).toEqual(rows.map((row) => row.id));
  });

  it('loads the page even when the seed factory throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repository = await openRepository({
      seed: (): readonly Booking[] => {
        throw new Error('seed builder blew up');
      },
    });
    expect(repository.kind).toBe('indexeddb');
    expect(await repository.listBookings()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
