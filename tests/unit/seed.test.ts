/**
 * The seeded diary (T-034).
 *
 * `src/config/seed.ts` exists to arrange one moment: a reviewer asks for the
 * most obvious booking there is — four people, Friday, seven o'clock — and the
 * engine refuses and offers three real alternatives it computed from actual
 * table inventory. Plan §10.6 calls that "a designed demo moment, not an
 * accident". This file is what stops it becoming one.
 *
 * The number three is load-bearing and fragile: it falls out of Friday's
 * opening time, the 105-minute turn for a party of four, and the ±120-minute
 * alternative search. Move any of those and the demo changes. The assertion
 * below is how you find out.
 *
 * Everything here is also checked *relative to the injected clock*. A seeded
 * diary pinned to August 2026 would quietly become a list of bookings in the
 * past, and the demo is supposed to still work in two years untouched.
 */

import { describe, expect, it } from 'vitest';

import { buildSeedDiary, nextFriday, toDiaryEntries } from '../../src/config/seed.js';
import type { Booking, DiaryEntry, IsoDate } from '../../src/engine/index.js';
import { addDays, checkAvailability, minutesOf, turnTimeFor, weekdayOf } from '../../src/engine/index.js';
import { CONFIG, FRIDAY, NOW_ISO, TODAY, makeDeps } from '../helpers/engine.js';

const seeded: readonly Booking[] = buildSeedDiary(CONFIG, TODAY, NOW_ISO);
const entries: readonly DiaryEntry[] = toDiaryEntries(seeded);

describe('nextFriday', () => {
  it('is the Friday the whole demo is arranged around', () => {
    expect(nextFriday(TODAY)).toBe(FRIDAY);
    expect(weekdayOf(FRIDAY)).toBe('fri');
  });

  it('returns a Friday strictly ahead, whatever day it is asked on', () => {
    // Seven consecutive days covers every weekday exactly once, including the
    // Friday itself — where "next" must mean the one a week away, not today.
    for (let offset = 0; offset < 7; offset += 1) {
      const today = addDays(TODAY, offset);
      const friday = nextFriday(today);
      expect(weekdayOf(friday), `nextFriday(${today})`).toBe('fri');
      expect(friday > today, `nextFriday(${today}) = ${friday}`).toBe(true);
    }
  });
});

describe('the seeded diary', () => {
  it('is obviously demo data', () => {
    expect(seeded.length).toBeGreaterThan(0);
    for (const booking of seeded) {
      // Both of these are how a reader — or a bug report — tells a seeded row
      // from something a visitor actually did.
      expect(booking.seeded).toBe(true);
      expect(booking.reference.startsWith('EO')).toBe(true);
    }
  });

  it('holds each table for the turn time the config specifies', () => {
    for (const booking of seeded) {
      expect(booking.durationMinutes, `${booking.reference} (party of ${booking.partySize})`).toBe(
        turnTimeFor(booking.partySize, CONFIG),
      );
    }
  });

  it('only books tables the room has, and seats that fit them', () => {
    const classes = new Map(CONFIG.tables.map((t) => [t.id, t]));
    for (const booking of seeded) {
      const table = classes.get(booking.tableId);
      expect(table, `${booking.reference} sits on unknown table ${booking.tableId}`).toBeDefined();
      expect(booking.partySize).toBeLessThanOrEqual(table?.seats ?? 0);
    }
  });

  it('never over-subscribes a table class', () => {
    // The bug this catches is the tempting one: seeding "enough" bookings to
    // block a slot by writing more of them than the room has tables. That would
    // make the demo work and every availability number after it a lie.
    const byDate = new Map<IsoDate, Booking[]>();
    for (const booking of seeded) {
      const list = byDate.get(booking.date) ?? [];
      list.push(booking);
      byDate.set(booking.date, list);
    }

    for (const [date, day] of byDate) {
      // Every booking's start is an instant where occupancy can only rise, so
      // checking those alone is enough to find any overlap.
      for (const instant of day.map((b) => minutesOf(b.time))) {
        for (const table of CONFIG.tables) {
          const busy = day.filter(
            (b) =>
              b.tableId === table.id &&
              minutesOf(b.time) <= instant &&
              minutesOf(b.time) + b.durationMinutes > instant,
          ).length;
          expect(busy, `${date} at ${instant} minutes: ${table.id}`).toBeLessThanOrEqual(table.count);
        }
      }
    }
  });

  it('is deterministic', () => {
    // The transcripts, the e2e snapshots and the alternatives count all assume
    // two builds of the same day are byte-identical.
    expect(buildSeedDiary(CONFIG, TODAY, NOW_ISO)).toEqual(buildSeedDiary(CONFIG, TODAY, NOW_ISO));
  });

  it('moves with the clock rather than being pinned to a date', () => {
    const laterToday = addDays(TODAY, 30);
    const later = buildSeedDiary(CONFIG, laterToday, NOW_ISO);

    expect(later.length).toBe(seeded.length);
    const fridays = new Set(later.filter((b) => weekdayOf(b.date) === 'fri').map((b) => b.date));
    expect(fridays).toEqual(new Set([nextFriday(laterToday)]));
    // Nothing seeded in the past, ever — that is the failure this guards.
    for (const booking of later) expect(booking.date >= laterToday).toBe(true);
  });
});

describe('the designed demo moment (plan §10.6)', () => {
  const deps = makeDeps({ seeded: true });

  it('refuses seven o clock on the Friday for a party of four', () => {
    const result = checkAvailability({ date: FRIDAY, time: '19:00', partySize: 4 }, deps);

    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.rejection.reason).toBe('no_availability');
  });

  it('offers exactly three alternatives, and all three are real', () => {
    const result = checkAvailability({ date: FRIDAY, time: '19:00', partySize: 4 }, deps);
    expect(result.available).toBe(false);
    if (result.available) return;

    // Three, exactly. See the file header: this number is a consequence of the
    // seeded times, not a target the code aims at.
    expect(result.alternatives.length).toBe(3);
    expect(result.alternatives.map((a) => a.time)).toEqual(['20:15', '20:30', '20:45']);

    for (const alternative of result.alternatives) {
      const check = checkAvailability({ ...alternative, partySize: 4 }, deps);
      expect(check.available, `alternative ${alternative.date} ${alternative.time}`).toBe(true);
    }
  });

  it('still seats a party of two at the same time', () => {
    // Documented as correct rather than convenient: only the four- and six-tops
    // are held at 19:00, so the room genuinely does have space for two.
    const result = checkAvailability({ date: FRIDAY, time: '19:00', partySize: 2 }, deps);
    expect(result.available).toBe(true);
  });

  it('is what the diary the app actually loads contains', () => {
    // Guards against the seed and the deps helper diverging — the demo is only
    // designed if the thing on screen is the thing asserted here.
    expect(deps.diary).toEqual(entries);
  });
});
