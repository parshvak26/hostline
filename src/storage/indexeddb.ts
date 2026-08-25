/**
 * The IndexedDB repository (T-047).
 *
 * ## What is stored, and where it goes
 *
 * Bookings hold a name and a phone number, because a restaurant booking does.
 * They are written to IndexedDB **on the visitor's own machine and nowhere
 * else** — nothing here is uploaded, synced or mirrored, there is no server
 * that could receive it, and "Clear demo data" wipes both stores in one click
 * (plan §10.6, §13). The README makes that claim; this file is where it is
 * either true or not.
 *
 * ## Why the raw callback API and not `idb`
 *
 * Runtime dependencies in the web app are targeted at zero (plan §13), and the
 * subset of IndexedDB this project needs is four operations on two stores. The
 * wrapper below is smaller than the argument for adding a package.
 *
 * ## Why every method swallows its errors
 *
 * A booking that fails to write is a bad outcome; a page that throws while
 * writing it is a worse one. Storage is the least important thing on screen and
 * has the most ways to fail — quota, a database corrupted by an earlier crash,
 * an origin whose storage was cleared mid-session. So each method degrades to
 * an empty result and warns, with one exception: {@link init} rejects, because
 * `openRepository` is listening for exactly that in order to fall back to the
 * in-memory store (F10). That is the only signal anyone acts on.
 */

import { STORAGE } from '../config/settings.js';
import type { Booking } from '../engine/index.js';
import type { BookingRepository, Transcript } from '../agent/ports.js';

/**
 * The diary view lists a day at a time, so bookings are indexed by date.
 *
 * Not consulted by anything today — `listBookings` reads the whole store,
 * which for a demo diary is a few dozen rows — but the index has to exist
 * before there is data, or adding it later means a version bump on a database
 * that already holds the visitor's bookings.
 */
const BOOKING_DATE_INDEX = 'by-date';

/* ------------------------------------------------------- minimal IDB types -- */

/*
 * The DOM's IndexedDB types describe events this code never inspects and
 * generics that fight `exactOptionalPropertyTypes`. What is actually used is
 * about twenty members, so they are declared here and the global factory is
 * cast to them once. The narrower surface is also what makes a hand-rolled
 * fake in the unit tests an honest stand-in rather than a puppet.
 */

interface IdbError {
  readonly name?: string;
  readonly message?: string;
}

interface RequestLike<T> {
  readonly result: T;
  readonly error: IdbError | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface OpenRequestLike extends RequestLike<DatabaseLike> {
  /** The versionchange transaction, live only during `onupgradeneeded`. */
  readonly transaction: TransactionLike | null;
  onupgradeneeded: (() => void) | null;
  onblocked: (() => void) | null;
}

interface FactoryLike {
  open(name: string, version: number): OpenRequestLike;
}

interface NameListLike {
  contains(name: string): boolean;
}

interface ObjectStoreLike {
  readonly indexNames: NameListLike;
  createIndex(name: string, keyPath: string, options?: { unique: boolean }): unknown;
  put(value: unknown): RequestLike<unknown>;
  getAll(): RequestLike<unknown[]>;
  clear(): RequestLike<unknown>;
}

interface TransactionLike {
  objectStore(name: string): ObjectStoreLike;
  readonly error: IdbError | null;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

interface DatabaseLike {
  readonly objectStoreNames: NameListLike;
  createObjectStore(name: string, options: { keyPath: string }): ObjectStoreLike;
  transaction(names: string[], mode: 'readonly' | 'readwrite'): TransactionLike;
  close(): void;
  onversionchange: (() => void) | null;
}

/* ------------------------------------------------------------- primitives -- */

function asError(error: IdbError | null, fallback: string): Error {
  if (error === null) return new Error(fallback);
  return new Error(`${error.name ?? 'IndexedDB'}: ${error.message ?? fallback}`);
}

/** True when this environment has IndexedDB at all — Node, or a locked-down origin, does not. */
function factory(): FactoryLike | null {
  const candidate: unknown = globalThis.indexedDB;
  if (candidate === null || candidate === undefined) return null;
  const asFactory = candidate as FactoryLike;
  return typeof asFactory.open === 'function' ? asFactory : null;
}

/**
 * Create the stores this version needs.
 *
 * Runs both for a brand-new database (`objectStoreNames` empty) and for a
 * version bump on an existing one, which is why every step asks before it
 * creates. Adding a store or an index in a future version means extending this
 * function, not rewriting it.
 */
function upgrade(db: DatabaseLike, versionChange: TransactionLike | null): void {
  const bookings = db.objectStoreNames.contains(STORAGE.bookingStore)
    ? // Already there from an earlier version: reach it through the
      // versionchange transaction, the only place indexes may be added.
      (versionChange?.objectStore(STORAGE.bookingStore) ?? null)
    : db.createObjectStore(STORAGE.bookingStore, { keyPath: 'id' });

  if (bookings !== null && !bookings.indexNames.contains(BOOKING_DATE_INDEX)) {
    bookings.createIndex(BOOKING_DATE_INDEX, 'date', { unique: false });
  }

  if (!db.objectStoreNames.contains(STORAGE.transcriptStore)) {
    db.createObjectStore(STORAGE.transcriptStore, { keyPath: 'id' });
  }
}

/**
 * Open the database, or reject.
 *
 * Every exit is wired: `onerror` for a refused or corrupt database, `onblocked`
 * for another tab holding an older version open, and the synchronous throw that
 * Firefox's private mode used to produce from `open()` itself. A path left
 * unwired would not fail — it would hang, and the page would sit there with a
 * promise nobody resolves.
 */
function openDatabase(idb: FactoryLike): Promise<DatabaseLike> {
  return new Promise<DatabaseLike>((resolve, reject) => {
    let request: OpenRequestLike;
    try {
      request = idb.open(STORAGE.dbName, STORAGE.dbVersion);
    } catch (cause) {
      reject(cause instanceof Error ? cause : new Error(String(cause)));
      return;
    }

    request.onupgradeneeded = (): void => {
      upgrade(request.result, request.transaction);
    };
    request.onsuccess = (): void => {
      const db = request.result;
      // Another tab wants to upgrade. Letting go immediately is the difference
      // between a stale tab and a stale tab that blocks every other one.
      db.onversionchange = (): void => {
        db.close();
      };
      resolve(db);
    };
    request.onerror = (): void => {
      reject(asError(request.error, 'could not open the database'));
    };
    request.onblocked = (): void => {
      reject(new Error('another tab is holding an older version of the database open'));
    };
  });
}

/** Resolve with a request's result, rejecting if either the request or its transaction fails. */
function read<T>(tx: TransactionLike, request: RequestLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = (): void => {
      resolve(request.result);
    };
    request.onerror = (): void => {
      reject(asError(request.error, 'read failed'));
    };
    tx.onerror = (): void => {
      reject(asError(tx.error, 'read transaction failed'));
    };
    tx.onabort = (): void => {
      reject(asError(tx.error, 'read transaction aborted'));
    };
  });
}

/**
 * Resolve when the write *commits*, not when the request succeeds.
 *
 * A `put` reports success well before the transaction is durable, and quota
 * errors arrive at commit time. Waiting for `oncomplete` is the difference
 * between "the browser accepted this" and "this survives a refresh", which is
 * the whole claim being made by `persistent: true`.
 */
function write(tx: TransactionLike, ...requests: ReadonlyArray<RequestLike<unknown>>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    for (const request of requests) {
      request.onerror = (): void => {
        reject(asError(request.error, 'write failed'));
      };
    }
    tx.oncomplete = (): void => {
      resolve();
    };
    tx.onerror = (): void => {
      reject(asError(tx.error, 'write transaction failed'));
    };
    tx.onabort = (): void => {
      reject(asError(tx.error, 'write transaction aborted'));
    };
  });
}

/* ------------------------------------------------------------ repository -- */

/**
 * A `BookingRepository` backed by IndexedDB.
 *
 * Nothing is opened until {@link BookingRepository.init} is called, and every
 * other method is a no-op until it succeeds — `openRepository` never hands out
 * an instance whose `init` failed.
 */
export function createIndexedDbRepository(): BookingRepository {
  let db: DatabaseLike | null = null;

  const stores = [STORAGE.bookingStore, STORAGE.transcriptStore];

  async function readAll<T>(store: string): Promise<T[]> {
    if (db === null) return [];
    try {
      const tx = db.transaction([store], 'readonly');
      const rows = await read(tx, tx.objectStore(store).getAll());
      return rows as T[];
    } catch (cause) {
      // An empty diary reads as "nothing booked yet", which is a state the UI
      // already draws well. Throwing here would take the page with it.
      console.warn(`hostline: could not read ${store}`, cause);
      return [];
    }
  }

  async function put(store: string, value: unknown): Promise<void> {
    if (db === null) return;
    try {
      const tx = db.transaction([store], 'readwrite');
      await write(tx, tx.objectStore(store).put(value));
    } catch (cause) {
      // Swallowed rather than surfaced: `BookingRepository.saveBooking` returns
      // void, and the conversation has already committed. The visitor has their
      // reference number either way; only the diary row is lost.
      console.warn(`hostline: could not write to ${store}`, cause);
    }
  }

  return {
    kind: 'indexeddb',
    persistent: true,

    async init(): Promise<void> {
      if (db !== null) return;
      const idb = factory();
      if (idb === null) throw new Error('IndexedDB is not available in this environment');
      // The one method that rejects. `openRepository` catches this and falls
      // back to the in-memory store (F10).
      db = await openDatabase(idb);
    },

    listBookings(): Promise<Booking[]> {
      return readAll<Booking>(STORAGE.bookingStore);
    },

    saveBooking(booking: Booking): Promise<void> {
      return put(STORAGE.bookingStore, booking);
    },

    saveTranscript(transcript: Transcript): Promise<void> {
      return put(STORAGE.transcriptStore, transcript);
    },

    listTranscripts(): Promise<Transcript[]> {
      return readAll<Transcript>(STORAGE.transcriptStore);
    },

    /** Backs the visible "Clear demo data" control (plan §10.6). Both stores, one transaction. */
    async clear(): Promise<void> {
      if (db === null) return;
      try {
        const tx = db.transaction(stores, 'readwrite');
        await write(
          tx,
          tx.objectStore(STORAGE.bookingStore).clear(),
          tx.objectStore(STORAGE.transcriptStore).clear(),
        );
      } catch (cause) {
        console.warn('hostline: could not clear storage', cause);
      }
    },
  };
}
