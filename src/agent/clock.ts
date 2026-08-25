/**
 * The impure edge of timekeeping and identity.
 *
 * The engine cannot read a clock or generate an id (R-43), so both arrive
 * through `EngineDeps`. This file is where the real ones are built, and it is
 * the only place in the project that calls `Date` or `crypto` for these
 * purposes. Everything downstream is deterministic, which is what makes
 * "requesting the deliberately-full Friday slot returns exactly three
 * alternatives" a testable statement rather than a hope.
 */

import type { Clock, IdSource, Instant } from '../engine/index.js';

/**
 * Reference-code alphabet.
 *
 * References are read aloud, so the pairs that get misheard are removed:
 * `O`/`0` and `I`/`1`. Five characters from the remaining 32 gives ~33 million
 * codes, which is comfortably more than a per-browser demo diary will ever hold
 * — collisions are not the constraint here, dictating them is.
 */
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERENCE_LENGTH = 5;

/**
 * Resolve the current instant into the restaurant's local civil calendar.
 *
 * `Intl.DateTimeFormat` does the timezone arithmetic — including whatever DST
 * rules the zone has — once, here. After this, the whole booking domain is
 * integer arithmetic on date and time strings.
 */
export function systemClock(timezone: string): Clock {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return {
    now(): Instant {
      const parts = formatter.formatToParts(new Date());
      const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
      // `hour12: false` yields "24" for midnight in some engines. Normalising
      // here rather than downstream keeps `minutesOf` from returning NaN at the
      // one time of day nobody tests by hand.
      const hour = get('hour') === '24' ? '00' : get('hour');
      return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        time: `${hour}:${get('minute')}`,
        iso: new Date().toISOString(),
      };
    },
  };
}

/** A clock frozen at a known instant. Used by tests, fixtures and the seeder. */
export function fixedClock(instant: Instant): Clock {
  return { now: () => instant };
}

/**
 * Real identifiers.
 *
 * `crypto.getRandomValues` where available, falling back to `Math.random` in
 * the rare environment without it. The fallback is fine: these identify rows in
 * one visitor's own IndexedDB, not anything anyone could gain from guessing.
 */
export function systemIds(): IdSource {
  const randomBytes = (length: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    const webCrypto = globalThis.crypto;
    if (webCrypto !== undefined && typeof webCrypto.getRandomValues === 'function') {
      webCrypto.getRandomValues(bytes);
      return bytes;
    }
    for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return bytes;
  };

  return {
    newId(): string {
      // ULID-shaped: a time prefix so ids sort chronologically, then entropy.
      const time = Date.now().toString(36).padStart(9, '0');
      const suffix = Array.from(randomBytes(8), (b) => (b % 36).toString(36)).join('');
      return `${time}${suffix}`;
    },
    newReference(): string {
      const bytes = randomBytes(REFERENCE_LENGTH);
      return Array.from(bytes, (b) => REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length] ?? 'A').join('');
    },
  };
}

/**
 * Predictable identifiers, for tests, fixtures and the seeded diary.
 *
 * A booking reference that changes on every run would make transcript snapshots
 * and the seeded diary unstable, and both need to be byte-identical to be worth
 * asserting on.
 */
export function deterministicIds(seed = 1): IdSource {
  let counter = seed;
  const next = (): number => {
    // A small xorshift. Not a good PRNG, and it does not need to be — it needs
    // to be the same on every machine and in every browser.
    counter ^= counter << 13;
    counter ^= counter >>> 17;
    counter ^= counter << 5;
    return Math.abs(counter);
  };

  return {
    newId(): string {
      return `id-${next().toString(36)}`;
    },
    newReference(): string {
      let out = '';
      for (let i = 0; i < REFERENCE_LENGTH; i += 1) {
        out += REFERENCE_ALPHABET[next() % REFERENCE_ALPHABET.length] ?? 'A';
      }
      return out;
    },
  };
}
