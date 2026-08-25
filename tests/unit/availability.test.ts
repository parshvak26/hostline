/**
 * T-027 — the availability engine, plan §10.5.
 *
 * This is the file that has to be right for the project's central claim to
 * hold. The engine is what says no to a confident model, so every one of the
 * seven steps in §10.5 gets its own `describe` block, and the half-open
 * interval rule — plan §19 names it as the phase's likeliest failure point —
 * is probed from both directions rather than once from the convenient side.
 *
 * Every case starts from an empty diary and fills it deliberately, so a test
 * that says "the room is full" can be read as evidence rather than as a
 * side-effect of shared fixtures.
 */

import { describe, expect, it } from 'vitest';

import {
  CLOSURE_DATE,
  CONFIG,
  FRIDAY,
  MONDAY,
  SUNDAY,
  THURSDAY,
  TODAY,
  TUESDAY,
  WEDNESDAY,
  entry,
  fill,
  fullRoom,
  makeDeps,
} from '../helpers/engine.js';
import {
  addDays,
  checkAvailability,
  checkDate,
  checkTime,
  closureOn,
  findAlternatives,
  isSeatable,
  turnTimeFor,
  weekdayOf,
  windowsFor,
} from '../../src/engine/index.js';
import type { AvailabilityResult, DiaryEntry, RejectionReason } from '../../src/engine/index.js';

type Refusal = Extract<AvailabilityResult, { available: false }>;
type Success = Extract<AvailabilityResult, { available: true }>;

/** Narrow to the success arm, failing loudly with the reason if it refused. */
function seated(result: AvailabilityResult): Success {
  if (!result.available) {
    throw new Error(`expected a table, got ${result.rejection.reason}: ${result.rejection.detail}`);
  }
  return result;
}

/** Narrow to the refusal arm and assert the typed reason, not the prose. */
function refused(result: AvailabilityResult, reason: RejectionReason): Refusal {
  if (result.available) {
    throw new Error(`expected a refusal (${reason}), got table ${result.tableId}`);
  }
  expect(result.rejection.reason).toBe(reason);
  return result;
}

/** Every table in the room busy from `time` for `durationMinutes`, bar one class. */
function busyExcept(exclude: string, date: string, time = '18:30', durationMinutes = 300): DiaryEntry[] {
  return CONFIG.tables
    .filter((t) => t.id !== exclude)
    .flatMap((t) => fill(date, time, t.id, durationMinutes, t.count));
}

describe('fixture dates', () => {
  it('are the weekdays the rest of this file relies on', () => {
    // Asserted rather than assumed: every last-seating and closed-day case below
    // is meaningless if the pinned dates drift.
    expect(weekdayOf(TODAY)).toBe('tue');
    expect(weekdayOf(MONDAY)).toBe('mon');
    expect(weekdayOf(TUESDAY)).toBe('tue');
    expect(weekdayOf(WEDNESDAY)).toBe('wed');
    expect(weekdayOf(THURSDAY)).toBe('thu');
    expect(weekdayOf(FRIDAY)).toBe('fri');
    expect(weekdayOf(SUNDAY)).toBe('sun');
  });
});

describe('§10.5 step 4 — best fit', () => {
  it('seats a party of two at a two-top while one is free', () => {
    const result = seated(checkAvailability({ date: TUESDAY, time: '19:00', partySize: 2 }, makeDeps()));
    expect(result.tableId).toBe('T2');
  });

  it('spills a party of two to a four-top only once all six two-tops are taken', () => {
    // The point of best fit is that this is the *second* choice, not the first.
    const deps = makeDeps({ diary: fill(TUESDAY, '19:00', 'T2', 90, 6) });
    expect(seated(checkAvailability({ date: TUESDAY, time: '19:00', partySize: 2 }, deps)).tableId).toBe('T4');
  });

  it('spills a party of two to a six-top once two-tops and four-tops are gone', () => {
    const deps = makeDeps({
      diary: [...fill(TUESDAY, '19:00', 'T2', 90, 6), ...fill(TUESDAY, '19:00', 'T4', 90, 5)],
    });
    expect(seated(checkAvailability({ date: TUESDAY, time: '19:00', partySize: 2 }, deps)).tableId).toBe('T6');
  });

  it('never offers a two-top to a party of four', () => {
    const result = seated(checkAvailability({ date: TUESDAY, time: '19:00', partySize: 4 }, makeDeps()));
    expect(result.tableId).toBe('T4');
  });

  it('gives a party of five the six-top, the only class that seats it', () => {
    const result = seated(checkAvailability({ date: TUESDAY, time: '19:00', partySize: 5 }, makeDeps()));
    expect(result.tableId).toBe('T6');
  });

  it('refuses only when every class that could seat the party is full', () => {
    // Two-tops are free, but a party of four cannot use them.
    const deps = makeDeps({
      diary: [...fill(TUESDAY, '19:00', 'T4', 105, 5), ...fill(TUESDAY, '19:00', 'T6', 120, 2)],
    });
    refused(checkAvailability({ date: TUESDAY, time: '19:00', partySize: 4 }, deps), 'no_availability');
    expect(seated(checkAvailability({ date: TUESDAY, time: '19:00', partySize: 2 }, deps)).tableId).toBe('T2');
  });
});

describe('§10.5 step 5 — half-open intervals [start, start + duration)', () => {
  // A party of four turns in 105 minutes, so an 18:30 booking runs 18:30–20:15.
  // Both directions of that boundary get their own case, because an off-by-one
  // here either double-books a table or refuses a bookable one, and neither
  // shows up in a test that only probes the middle of an interval.
  const t4AllEvening = fill(TUESDAY, '18:30', 'T4', 105, 5);
  const t6AllEvening = fill(TUESDAY, '18:30', 'T6', 300, 2);
  const lastT4Deps = makeDeps({ diary: [...t4AllEvening, ...t6AllEvening] });

  it('frees a table at the exact minute the previous booking ends', () => {
    const result = seated(checkAvailability({ date: TUESDAY, time: '20:15', partySize: 4 }, lastT4Deps));
    expect(result.tableId).toBe('T4');
  });

  it('still holds the table one slot before that end', () => {
    refused(checkAvailability({ date: TUESDAY, time: '20:00', partySize: 4 }, lastT4Deps), 'no_availability');
  });

  it('is not blocked by a booking that starts exactly when the request ends', () => {
    // Mirror image of the case above: the boundary is now at the *far* end of
    // the requested interval.
    const diary = [
      ...fill(TUESDAY, '18:30', 'T4', 300, 4),
      ...fill(TUESDAY, '18:30', 'T6', 300, 2),
      entry(TUESDAY, '20:15', 'T4', 105),
    ];
    const result = seated(checkAvailability({ date: TUESDAY, time: '18:30', partySize: 4 }, makeDeps({ diary })));
    expect(result.tableId).toBe('T4');
  });

  it('is blocked by that same booking one slot earlier', () => {
    const diary = [
      ...fill(TUESDAY, '18:30', 'T4', 300, 4),
      ...fill(TUESDAY, '18:30', 'T6', 300, 2),
      entry(TUESDAY, '20:00', 'T4', 105),
    ];
    refused(
      checkAvailability({ date: TUESDAY, time: '18:30', partySize: 4 }, makeDeps({ diary })),
      'no_availability',
    );
  });

  it('counts overlaps per date, so yesterday’s full room does not block today', () => {
    const deps = makeDeps({ diary: fullRoom(WEDNESDAY) });
    expect(seated(checkAvailability({ date: TUESDAY, time: '19:00', partySize: 2 }, deps)).tableId).toBe('T2');
  });

  it('counts overlaps per table class, so a full six-top row leaves two-tops alone', () => {
    const deps = makeDeps({ diary: fill(TUESDAY, '19:00', 'T6', 120, 2) });
    expect(seated(checkAvailability({ date: TUESDAY, time: '19:00', partySize: 2 }, deps)).tableId).toBe('T2');
    refused(checkAvailability({ date: TUESDAY, time: '19:00', partySize: 5 }, deps), 'no_availability');
  });
});

describe('§10.5 step 3 — turn times come from the config', () => {
  it('reports the configured duration for each party size it can seat', () => {
    const deps = makeDeps();
    const durationFor = (partySize: number): number =>
      seated(checkAvailability({ date: TUESDAY, time: '19:00', partySize }, deps)).durationMinutes;

    expect(durationFor(1)).toBe(75);
    expect(durationFor(2)).toBe(90);
    expect(durationFor(3)).toBe(105);
    expect(durationFor(4)).toBe(105);
    expect(durationFor(5)).toBe(120);
    expect(durationFor(6)).toBe(120);
  });

  it('uses that duration when counting overlaps, not a fixed one', () => {
    // A party of one turns in 75 minutes, so 18:30 bookings clear at 19:45 —
    // fifteen minutes before a party of two would have.
    const diary = [
      ...fill(TUESDAY, '18:30', 'T2', 75, 6),
      ...fill(TUESDAY, '18:30', 'T4', 300, 5),
      ...fill(TUESDAY, '18:30', 'T6', 300, 2),
    ];
    const deps = makeDeps({ diary });
    expect(seated(checkAvailability({ date: TUESDAY, time: '19:45', partySize: 1 }, deps)).tableId).toBe('T2');
    refused(checkAvailability({ date: TUESDAY, time: '19:30', partySize: 1 }, deps), 'no_availability');
  });
});

describe('§10.5 step 1 — date rules', () => {
  it('refuses a Monday, when the restaurant is closed', () => {
    refused(checkAvailability({ date: MONDAY, time: '19:00', partySize: 2 }, makeDeps()), 'date_closed_day');
  });

  it('refuses a configured closure date and says why', () => {
    const result = refused(
      checkAvailability({ date: CLOSURE_DATE, time: '19:00', partySize: 2 }, makeDeps()),
      'date_closure',
    );
    expect(result.rejection.detail).toContain('Diwali');
  });

  it('refuses a date that has already gone by', () => {
    refused(checkAvailability({ date: '2026-07-01', time: '19:00', partySize: 2 }, makeDeps()), 'date_in_past');
  });

  it('refuses one day beyond the horizon', () => {
    const beyond = addDays(TODAY, CONFIG.service.horizonDays + 1);
    refused(checkAvailability({ date: beyond, time: '19:00', partySize: 2 }, makeDeps()), 'date_beyond_horizon');
  });

  it('accepts the last day inside the horizon', () => {
    // The horizon is inclusive; today + 60 is the last bookable date.
    const edge = addDays(TODAY, CONFIG.service.horizonDays);
    expect(weekdayOf(edge)).toBe('sat');
    const check = checkDate(edge, makeDeps());
    expect(check.ok).toBe(true);
    expect(seated(checkAvailability({ date: edge, time: '19:00', partySize: 2 }, makeDeps())).tableId).toBe('T2');
  });

  it('checks the past before the horizon, so an ancient date reads as past', () => {
    refused(checkAvailability({ date: '1999-01-01', time: '19:00', partySize: 2 }, makeDeps()), 'date_in_past');
  });
});

describe('§10.5 step 2 — opening windows and last seating', () => {
  it('refuses a Friday afternoon that falls between the two windows', () => {
    // 16:00 is the case a single-window restaurant never exercises: after lunch
    // service, before dinner service, and inside neither.
    const result = refused(
      checkAvailability({ date: FRIDAY, time: '16:00', partySize: 2 }, makeDeps()),
      'time_outside_hours',
    );
    expect(result.rejection.detail).toContain('12:30 to 15:00');
    expect(result.rejection.detail).toContain('18:30 to 23:00');
  });

  it('refuses a Friday morning before lunch service', () => {
    refused(checkAvailability({ date: FRIDAY, time: '11:00', partySize: 2 }, makeDeps()), 'time_outside_hours');
  });

  it('refuses a Friday time after the kitchen has closed', () => {
    refused(checkAvailability({ date: FRIDAY, time: '23:30', partySize: 2 }, makeDeps()), 'time_outside_hours');
  });

  it('accepts 22:00 on a Friday, exactly one hour before close', () => {
    expect(seated(checkAvailability({ date: FRIDAY, time: '22:00', partySize: 2 }, makeDeps())).tableId).toBe('T2');
  });

  it('refuses 22:15 on a Friday as after last seating', () => {
    const result = refused(
      checkAvailability({ date: FRIDAY, time: '22:15', partySize: 2 }, makeDeps()),
      'time_after_last_seating',
    );
    expect(result.rejection.detail).toContain('22:00');
  });

  it('accepts 21:30 on a Tuesday, whose window closes half an hour earlier', () => {
    expect(seated(checkAvailability({ date: TUESDAY, time: '21:30', partySize: 2 }, makeDeps())).tableId).toBe('T2');
  });

  it('refuses 21:45 on a Tuesday as after last seating', () => {
    const result = refused(
      checkAvailability({ date: TUESDAY, time: '21:45', partySize: 2 }, makeDeps()),
      'time_after_last_seating',
    );
    expect(result.rejection.detail).toContain('21:30');
  });

  it('treats the closing minute itself as after last seating, not outside hours', () => {
    // The window is inclusive of its close, so the more specific rule wins and
    // the visitor hears "our last seating is 21:30" rather than "we're closed".
    refused(checkAvailability({ date: TUESDAY, time: '22:30', partySize: 2 }, makeDeps()), 'time_after_last_seating');
  });

  it('applies Sunday’s lunch-only hours', () => {
    expect(seated(checkAvailability({ date: SUNDAY, time: '15:00', partySize: 2 }, makeDeps())).tableId).toBe('T2');
    refused(checkAvailability({ date: SUNDAY, time: '19:00', partySize: 2 }, makeDeps()), 'time_outside_hours');
  });
});

describe('§10.2 — slot boundary and lead time', () => {
  it('refuses a time that is not on the 15-minute mark', () => {
    const result = refused(
      checkAvailability({ date: TUESDAY, time: '19:07', partySize: 2 }, makeDeps()),
      'time_not_on_slot_boundary',
    );
    expect(result.rejection.detail).toContain('15-minute');
  });

  it('refuses an unreadable time before anything else', () => {
    refused(checkAvailability({ date: TUESDAY, time: '25:00', partySize: 2 }, makeDeps()), 'time_unparseable');
  });

  it('refuses a request twenty minutes out when thirty minutes are required', () => {
    // 18:40 now, 19:00 asked for: inside opening hours, on a slot boundary, and
    // still too soon. Lead time is the only rule that can catch it.
    const deps = makeDeps({ today: FRIDAY, nowTime: '18:40' });
    refused(checkAvailability({ date: FRIDAY, time: '19:00', partySize: 2 }, deps), 'time_before_lead_time');
  });

  it('accepts a request thirty-five minutes out from the same moment', () => {
    const deps = makeDeps({ today: FRIDAY, nowTime: '18:40' });
    expect(seated(checkAvailability({ date: FRIDAY, time: '19:15', partySize: 2 }, deps)).tableId).toBe('T2');
  });

  it('accepts a request exactly at the lead-time boundary', () => {
    // 18:45 now, 19:15 asked for: thirty minutes, which the rule reads as enough.
    const deps = makeDeps({ today: FRIDAY, nowTime: '18:45' });
    expect(checkTime(FRIDAY, '19:15', deps).ok).toBe(true);
    expect(checkTime(FRIDAY, '19:00', deps).ok).toBe(false);
  });

  it('measures lead time across the day boundary, not within the calendar day', () => {
    // Late on a Friday, tomorrow lunchtime is many hours away even though the
    // clock reading is smaller.
    const deps = makeDeps({ today: FRIDAY, nowTime: '22:50' });
    expect(checkTime(addDays(FRIDAY, 1), '12:30', deps).ok).toBe(true);
  });
});

describe('§10.5 step 7 — party size, with combineTables off', () => {
  it('refuses a party above maxPartySize', () => {
    const result = refused(
      checkAvailability({ date: TUESDAY, time: '19:00', partySize: 9 }, makeDeps()),
      'party_too_large',
    );
    expect(result.alternatives).toEqual([]);
  });

  it('refuses a party below minPartySize', () => {
    const result = refused(
      checkAvailability({ date: TUESDAY, time: '19:00', partySize: 0 }, makeDeps()),
      'party_too_small',
    );
    expect(result.alternatives).toEqual([]);
  });

  it('refuses seven, which is inside maxPartySize but larger than any table', () => {
    // Deliberate, not a bug: §10.5 step 7 keeps combining off for the MVP, so a
    // seven needs a seven-seat table and the room has none. The refusal is what
    // the escalation path is built on.
    const result = refused(
      checkAvailability({ date: TUESDAY, time: '19:00', partySize: 7 }, makeDeps()),
      'party_too_large',
    );
    expect(result.rejection.detail).toContain('6');
  });

  it('refuses eight for the same reason', () => {
    refused(checkAvailability({ date: TUESDAY, time: '19:00', partySize: 8 }, makeDeps()), 'party_too_large');
  });

  it('reports seven as unseatable regardless of the diary', () => {
    expect(isSeatable(7, CONFIG)).toBe(false);
    expect(isSeatable(8, CONFIG)).toBe(false);
    expect(isSeatable(6, CONFIG)).toBe(true);
    expect(isSeatable(1, CONFIG)).toBe(true);
  });

  it('would seat seven if combining were on', () => {
    // Guards against the refusal being hard-coded rather than policy-driven.
    const combining = { ...CONFIG, policy: { ...CONFIG.policy, combineTables: true } };
    expect(isSeatable(7, combining)).toBe(true);
  });
});

describe('§10.5 step 6 — alternatives', () => {
  /**
   * A diary built so that 20:00 is full for a party of two while 19:45 and
   * 20:15 are both free. Half of each table class is held by bookings that end
   * at exactly 20:15, the other half by bookings that start at exactly 21:15 —
   * so a 20:00 request (which runs 20:00–21:30) collides with all of them, and
   * each neighbouring slot collides with only one half.
   */
  const tieDiary: DiaryEntry[] = [
    ...fill(TUESDAY, '18:45', 'T2', 90, 3),
    ...fill(TUESDAY, '21:15', 'T2', 90, 3),
    ...fill(TUESDAY, '18:45', 'T4', 90, 3),
    ...fill(TUESDAY, '21:15', 'T4', 90, 2),
    ...fill(TUESDAY, '18:45', 'T6', 90, 1),
    ...fill(TUESDAY, '21:15', 'T6', 90, 1),
  ];

  it('offers at most three', () => {
    const result = refused(
      checkAvailability({ date: TUESDAY, time: '20:00', partySize: 2 }, makeDeps({ diary: tieDiary })),
      'no_availability',
    );
    expect(result.alternatives.length).toBeLessThanOrEqual(3);
    expect(result.alternatives.length).toBe(3);
  });

  it('orders them nearest-first, with the earlier slot winning a tie', () => {
    // 19:45 and 20:15 are both fifteen minutes away. A host who says "quarter
    // to eight or quarter past" is offering the earlier one first, which is
    // what §10.5 step 6 specifies.
    const result = refused(
      checkAvailability({ date: TUESDAY, time: '20:00', partySize: 2 }, makeDeps({ diary: tieDiary })),
      'no_availability',
    );
    expect(result.alternatives).toEqual([
      { date: TUESDAY, time: '19:45' },
      { date: TUESDAY, time: '20:15' },
      { date: TUESDAY, time: '19:30' },
    ]);
  });

  it('offers only slots that are genuinely bookable', () => {
    const deps = makeDeps({ diary: tieDiary });
    const result = refused(
      checkAvailability({ date: TUESDAY, time: '20:00', partySize: 2 }, deps),
      'no_availability',
    );
    for (const alternative of result.alternatives) {
      const recheck = checkAvailability({ ...alternative, partySize: 2 }, deps);
      expect(recheck.available).toBe(true);
    }
  });

  it('never offers the requested time back', () => {
    const result = refused(
      checkAvailability({ date: TUESDAY, time: '20:00', partySize: 2 }, makeDeps({ diary: tieDiary })),
      'no_availability',
    );
    expect(result.alternatives.some((a) => a.time === '20:00')).toBe(false);
  });

  it('returns fewer than three when the day has fewer to give', () => {
    // 16:00 on a Friday sits in the gap between services. Only 14:00 — the
    // lunch last seating, two hours earlier — is inside the search radius.
    const result = refused(
      checkAvailability({ date: FRIDAY, time: '16:00', partySize: 2 }, makeDeps()),
      'time_outside_hours',
    );
    expect(result.alternatives).toEqual([{ date: FRIDAY, time: '14:00' }]);
  });

  it('spills to the nearest available dates when the whole day is full', () => {
    const result = refused(
      checkAvailability({ date: TUESDAY, time: '20:00', partySize: 2 }, makeDeps({ diary: fullRoom(TUESDAY) })),
      'no_availability',
    );
    expect(result.alternatives).toEqual([
      { date: WEDNESDAY, time: '20:00' },
      { date: THURSDAY, time: '20:00' },
      { date: FRIDAY, time: '20:00' },
    ]);
  });

  it('skips closed days when spilling forward', () => {
    // Sunday 20:00 is outside Sunday's lunch-only hours and Monday is shut, so
    // the search has to walk past both to reach Tuesday.
    const result = refused(
      checkAvailability({ date: SUNDAY, time: '20:00', partySize: 2 }, makeDeps()),
      'time_outside_hours',
    );
    expect(result.alternatives.some((a) => weekdayOf(a.date) === 'mon')).toBe(false);
    expect(result.alternatives.some((a) => a.date === SUNDAY)).toBe(false);
  });

  it('returns an empty array rather than throwing when there is nothing to offer', () => {
    // A date in the past has no nearby date that is not also in the past.
    const result = refused(
      checkAvailability({ date: '2026-07-01', time: '19:00', partySize: 2 }, makeDeps()),
      'date_in_past',
    );
    expect(result.alternatives).toEqual([]);
  });

  it('returns an empty array beyond the horizon, where every later date is worse', () => {
    const beyond = addDays(TODAY, CONFIG.service.horizonDays + 1);
    const result = refused(
      checkAvailability({ date: beyond, time: '19:00', partySize: 2 }, makeDeps()),
      'date_beyond_horizon',
    );
    expect(result.alternatives).toEqual([]);
  });

  it('offers nothing to a party it can never seat', () => {
    const result = findAlternatives({ date: TUESDAY, time: '19:00', partySize: 7 }, makeDeps());
    expect(result).toEqual([]);
  });

  it('returns [] for a limit of zero', () => {
    expect(findAlternatives({ date: TUESDAY, time: '20:00', partySize: 2 }, makeDeps({ diary: tieDiary }), 0)).toEqual(
      [],
    );
  });

  it('honours a limit below the maximum', () => {
    const one = findAlternatives({ date: TUESDAY, time: '20:00', partySize: 2 }, makeDeps({ diary: tieDiary }), 1);
    expect(one).toEqual([{ date: TUESDAY, time: '19:45' }]);
  });

  it('snaps an off-slot time to the grid before searching', () => {
    // A visitor who says "seven oh seven" is refused for not being on a
    // boundary — but they still deserve a better answer than silence. The
    // search rounds to the nearest slot first, so the refusal arrives with
    // "we seat on the quarter hour" *and* something to say yes to.
    //
    // Without the rounding, stepping outward from 19:07 lands on 18:52, 19:22,
    // 18:37 and so on, none of which are bookable times, and the agent ends up
    // sounding like the evening is full when it is wide open.
    const result = refused(
      checkAvailability({ date: TUESDAY, time: '19:07', partySize: 2 }, makeDeps()),
      'time_not_on_slot_boundary',
    );
    expect(result.alternatives.length).toBeGreaterThan(0);
    for (const alternative of result.alternatives) {
      expect(alternative.time).toMatch(/:(00|15|30|45)$/);
    }
  });

  it('respects lead time when suggesting, so nothing unbookable is offered', () => {
    const deps = makeDeps({ today: FRIDAY, nowTime: '18:40' });
    const result = refused(
      checkAvailability({ date: FRIDAY, time: '19:00', partySize: 2 }, deps),
      'time_before_lead_time',
    );
    expect(result.alternatives.length).toBeGreaterThan(0);
    for (const alternative of result.alternatives) {
      expect(checkTime(alternative.date, alternative.time, deps).ok).toBe(true);
    }
  });
});

describe('lookups', () => {
  it('windowsFor returns nothing on a closed day and both services on a Friday', () => {
    expect(windowsFor(MONDAY, CONFIG)).toEqual([]);
    expect(windowsFor(FRIDAY, CONFIG)).toEqual([
      ['12:30', '15:00'],
      ['18:30', '23:00'],
    ]);
    expect(windowsFor(SUNDAY, CONFIG)).toEqual([['12:30', '16:00']]);
  });

  it('closureOn returns the reason on a closure and null otherwise', () => {
    expect(closureOn(CLOSURE_DATE, CONFIG)).toBe('Diwali');
    expect(closureOn(TUESDAY, CONFIG)).toBeNull();
  });

  it('turnTimeFor reads the configured minutes for each party size', () => {
    expect(turnTimeFor(1, CONFIG)).toBe(75);
    expect(turnTimeFor(4, CONFIG)).toBe(105);
    expect(turnTimeFor(8, CONFIG)).toBe(135);
  });

  it('turnTimeFor falls back to the longest configured turn for an unknown size', () => {
    // Not reachable through checkAvailability, which rejects such a party
    // first — but the allocator must not produce NaN if it ever is.
    expect(turnTimeFor(12, CONFIG)).toBe(135);
    expect(turnTimeFor(0, CONFIG)).toBe(135);
  });

  it('checkDate and checkTime agree with checkAvailability on the same input', () => {
    const deps = makeDeps();
    expect(checkDate(MONDAY, deps).ok).toBe(false);
    expect(checkDate(TUESDAY, deps).ok).toBe(true);
    expect(checkTime(TUESDAY, '19:00', deps).ok).toBe(true);
    expect(checkTime(TUESDAY, '09:00', deps).ok).toBe(false);
  });

  it('busyExcept leaves exactly one class free, which best fit then finds', () => {
    // Sanity check on this file's own fixture builder.
    const deps = makeDeps({ diary: busyExcept('T6', TUESDAY) });
    expect(seated(checkAvailability({ date: TUESDAY, time: '19:00', partySize: 2 }, deps)).tableId).toBe('T6');
  });
});
