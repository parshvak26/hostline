/**
 * The in-memory repository — the F10 fallback (plan §7.5).
 *
 * This is what runs when IndexedDB cannot be opened: private browsing, storage
 * disabled by policy, a corrupt database. The visitor still books a table, the
 * diary still fills in, and the only difference is that a refresh forgets it.
 * `persistent: false` is how that difference is reported; the diary view turns
 * it into one small note (plan §4.6).
 *
 * The awkward part of a fallback is that it is exercised least and trusted
 * most, so the one thing this file must not do is behave *almost* like the real
 * store. IndexedDB structured-clones on the way in and on the way out, which
 * means a caller who mutates a booking it got back changes nothing. A plain
 * `Map` of shared references would not, and the bug that produces would only
 * appear in private browsing. Hence the copies below, and hence the conformance
 * suite that runs the same assertions against both implementations.
 */

import type { Booking } from '../engine/index.js';
import type { BookingRepository, Transcript } from '../agent/ports.js';

/**
 * Structured clone where the browser has it, JSON round-trip where it does not.
 *
 * Bookings and transcripts are plain JSON — strings, numbers, arrays — so the
 * round-trip is lossless for this data specifically. It is not a general
 * `structuredClone` polyfill and is not used as one.
 */
function copy<T>(value: T): T {
  const clone = globalThis.structuredClone;
  if (typeof clone === 'function') return clone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** An in-memory `BookingRepository`. Nothing here can fail, so nothing throws. */
export function createMemoryRepository(): BookingRepository {
  // Keyed by id so that saving the same booking twice replaces it, matching
  // IndexedDB's `put` rather than accumulating duplicates. The seeded diary
  // relies on this: its ids are stable, so a re-seed overwrites.
  const bookings = new Map<string, Booking>();
  const transcripts = new Map<string, Transcript>();

  return {
    kind: 'memory',
    persistent: false,

    init(): Promise<void> {
      return Promise.resolve();
    },

    listBookings(): Promise<Booking[]> {
      return Promise.resolve(Array.from(bookings.values(), copy));
    },

    saveBooking(booking: Booking): Promise<void> {
      bookings.set(booking.id, copy(booking));
      return Promise.resolve();
    },

    saveTranscript(transcript: Transcript): Promise<void> {
      transcripts.set(transcript.id, copy(transcript));
      return Promise.resolve();
    },

    listTranscripts(): Promise<Transcript[]> {
      return Promise.resolve(Array.from(transcripts.values(), copy));
    },

    clear(): Promise<void> {
      bookings.clear();
      transcripts.clear();
      return Promise.resolve();
    },
  };
}
