/**
 * Choosing a repository, and filling it on first load (T-047, plan §10.6).
 *
 * Two decisions live here and nowhere else:
 *
 *   1. **Which store.** IndexedDB if it opens, the in-memory store if it does
 *      not. F10 in the failure matrix says that swap is silent, so it is: no
 *      throw, no dialog, no log. What the rest of the app sees is
 *      `persistent: false`, which the diary turns into one small note. A
 *      visitor in private browsing books a table exactly as anyone else does
 *      and finds out only if they refresh.
 *   2. **Whether to seed.** The demo diary exists so that the most obvious
 *      request — a table for four on Friday at seven — hits the alternatives
 *      path (see `src/config/seed.ts`). It has to be inserted once, on first
 *      load, and never again.
 *
 * The seed rows arrive as an argument. This file reads no clock: the diary is
 * built relative to `today`, and a module that quietly consults `Date.now()`
 * would make "opening twice does not duplicate the diary" a test nobody could
 * write without mocking time.
 */

import type { Booking } from '../engine/index.js';
import type { BookingRepository } from '../agent/ports.js';
import { createIndexedDbRepository } from './indexeddb.js';
import { createMemoryRepository } from './memory.js';

export { createIndexedDbRepository } from './indexeddb.js';
export { createMemoryRepository } from './memory.js';
export type { BookingRepository, Transcript, TranscriptTurn } from '../agent/ports.js';

export interface RepositoryOptions {
  /**
   * The demo diary, built by the caller.
   *
   * A factory rather than an array so that a returning visitor — the common
   * case after the first load — never pays for building a diary that is
   * immediately discarded. Callers pass
   * `() => buildSeedDiary(config, clock.now().date, clock.now().iso)`.
   */
  readonly seed?: () => readonly Booking[];
  /** Skip IndexedDB. For tests, and for a debug flag that forces the F10 path. */
  readonly forceMemory?: boolean;
}

/**
 * Open the best available store, seed it if it is empty, and hand it back.
 *
 * Never rejects. There is no failure here that should be allowed to stop the
 * page loading, and in the worst case — no storage, no seed — the result is a
 * working in-memory repository with an empty diary.
 */
export async function openRepository(options: RepositoryOptions = {}): Promise<BookingRepository> {
  const repository = await openStore(options.forceMemory === true);
  await seedIfEmpty(repository, options.seed);
  return repository;
}

async function openStore(forceMemory: boolean): Promise<BookingRepository> {
  if (!forceMemory) {
    const indexed = createIndexedDbRepository();
    try {
      await indexed.init();
      return indexed;
    } catch {
      // Deliberately not logged. Private browsing, a storage policy and a
      // corrupt database all land here, none of them is the visitor's problem,
      // and `persistent: false` already tells the app everything it can act on.
    }
  }

  const memory = createMemoryRepository();
  await memory.init();
  return memory;
}

/**
 * Insert the demo diary, once.
 *
 * ## The marker is the store itself
 *
 * Idempotence is enforced by "seed only when `bookings` is empty" rather than
 * by a `meta` record or a scan for `seeded: true` rows. Both alternatives were
 * available; an emptiness check wins on two counts. It needs no third object
 * store, so the database stays the two stores the plan specifies and no
 * migration is invented for bookkeeping. And it is the same condition as the
 * rule the demo actually wants — *never inject a demo diary around a booking
 * the visitor made* — so one check does both jobs instead of two checks that
 * could disagree.
 *
 * A `meta` record would additionally have to survive "Clear demo data", and
 * then clearing would leave a permanently empty diary: exactly the blank screen
 * plan §4.4 forbids. Re-seeding after a clear on the *next* load is the wanted
 * behaviour, and this check gives it for free.
 *
 * ## The second guarantee
 *
 * Seeded ids are stable (`seed-<date>-<n>`, from `src/config/seed.ts`) and both
 * implementations write by key. So even if this ran twice — two tabs opening
 * together, an emptiness check that raced — the second pass would overwrite the
 * same seven rows rather than append seven more. The count cannot double.
 */
async function seedIfEmpty(repository: BookingRepository, seed?: () => readonly Booking[]): Promise<void> {
  if (seed === undefined) return;

  const existing = await repository.listBookings();
  if (existing.length > 0) return;

  try {
    for (const booking of seed()) {
      await repository.saveBooking(booking);
    }
  } catch (cause) {
    // A half-seeded diary is a cosmetic problem; a demo that will not load is
    // not. Neither implementation throws from `saveBooking`, so reaching this
    // means the seed factory itself failed.
    console.warn('hostline: could not seed the demo diary', cause);
  }
}
