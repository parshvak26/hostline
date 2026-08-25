/**
 * Civil date and time arithmetic — `src/engine/time.ts`.
 *
 * Everything the availability engine claims about interval boundaries rests on
 * this file being exact, and it is exact by construction: integer arithmetic on
 * the proleptic Gregorian calendar, with no `Date` anywhere. So the cases here
 * are chosen to be the ones a hand-rolled calendar gets wrong — the leap day,
 * the century that is not a leap year, the century that is, the year boundary,
 * and dates before the epoch, where a naive modulo goes negative.
 */

import { describe, expect, it } from 'vitest';

import {
  addDays,
  compareDates,
  daysBetween,
  daysInMonth,
  formatDateLong,
  formatTime12,
  fromDayNumber,
  isClockTime,
  isIsoDate,
  isLeapYear,
  minutesBetween,
  minutesOf,
  ordinal,
  parseIsoDate,
  spokenDate,
  spokenTime,
  timeFromMinutes,
  toDayNumber,
  toIsoDate,
  weekdayOf,
} from '../../src/engine/time.js';

/** The pinned Tuesday the engine suites are built around. */
const TUESDAY = '2026-08-25';

describe('isLeapYear', () => {
  it('follows the full Gregorian rule, not the divisible-by-four shorthand', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    // The two cases that separate a correct implementation from a plausible one.
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
  });

  it('holds at other century boundaries', () => {
    expect(isLeapYear(1600)).toBe(true);
    expect(isLeapYear(1700)).toBe(false);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2400)).toBe(true);
  });
});

describe('daysInMonth', () => {
  it('knows every month of a common year', () => {
    const lengths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => daysInMonth(2026, m));
    expect(lengths).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  });

  it('gives February 29 days in a leap year and 28 otherwise', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it('returns zero for a month that does not exist', () => {
    // Zero rather than a throw, because this feeds the config validator's error
    // message and must not blow up while explaining a bad date.
    expect(daysInMonth(2026, 0)).toBe(0);
    expect(daysInMonth(2026, 13)).toBe(0);
    expect(daysInMonth(2026, -1)).toBe(0);
  });
});

describe('parseIsoDate', () => {
  it('accepts a well-formed date', () => {
    expect(parseIsoDate('2026-08-25')).toEqual({ year: 2026, month: 8, day: 25 });
  });

  it('accepts a real leap day', () => {
    expect(parseIsoDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseIsoDate('2000-02-29')).toEqual({ year: 2000, month: 2, day: 29 });
  });

  it('rejects a day the month does not contain', () => {
    // The one that matters: "2026-02-30" parses fine as three integers and is
    // still not a date. The config validator relies on this to catch closures.
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('2026-04-31')).toBeNull();
    expect(parseIsoDate('1900-02-29')).toBeNull();
  });

  it('rejects a month outside 1..12', () => {
    expect(parseIsoDate('2026-13-01')).toBeNull();
    expect(parseIsoDate('2026-00-01')).toBeNull();
  });

  it('rejects a day of zero', () => {
    expect(parseIsoDate('2026-08-00')).toBeNull();
  });

  it('rejects anything that is not YYYY-MM-DD', () => {
    expect(parseIsoDate('not-a-date')).toBeNull();
    expect(parseIsoDate('2026-1-1')).toBeNull();
    expect(parseIsoDate('')).toBeNull();
    expect(parseIsoDate('2026/08/25')).toBeNull();
    expect(parseIsoDate('2026-08-25T19:00')).toBeNull();
  });

  it('agrees with isIsoDate', () => {
    expect(isIsoDate('2026-08-25')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
  });
});

describe('toIsoDate', () => {
  it('pads every component', () => {
    expect(toIsoDate({ year: 2026, month: 1, day: 5 })).toBe('2026-01-05');
    expect(toIsoDate({ year: 999, month: 12, day: 31 })).toBe('0999-12-31');
  });
});

describe('toDayNumber / fromDayNumber', () => {
  it('anchors on the Unix epoch', () => {
    expect(toDayNumber('1970-01-01')).toBe(0);
    expect(fromDayNumber(0)).toBe('1970-01-01');
  });

  it('goes negative before the epoch', () => {
    expect(toDayNumber('1969-12-31')).toBe(-1);
    expect(fromDayNumber(-1)).toBe('1969-12-31');
  });

  it('round-trips across a leap day', () => {
    for (const iso of ['2024-02-28', '2024-02-29', '2024-03-01']) {
      expect(fromDayNumber(toDayNumber(iso))).toBe(iso);
    }
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
  });

  it('round-trips across the 2000 century leap day', () => {
    // 2000 is a leap year despite ending the century, so the 29th exists.
    expect(fromDayNumber(toDayNumber('2000-02-29'))).toBe('2000-02-29');
    expect(daysBetween('2000-02-28', '2000-03-01')).toBe(2);
  });

  it('round-trips across the 1900 century boundary, which is not a leap year', () => {
    expect(fromDayNumber(toDayNumber('1900-03-01'))).toBe('1900-03-01');
    expect(daysBetween('1900-02-28', '1900-03-01')).toBe(1);
  });

  it('round-trips across a year boundary', () => {
    for (const iso of ['2025-12-31', '2026-01-01', '1999-12-31', '2000-01-01']) {
      expect(fromDayNumber(toDayNumber(iso))).toBe(iso);
    }
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });

  it('round-trips a long span of consecutive days without drifting', () => {
    let day = toDayNumber('2023-12-15');
    for (let i = 0; i < 500; i += 1) {
      const iso = fromDayNumber(day);
      expect(toDayNumber(iso)).toBe(day);
      day += 1;
    }
  });

  it('returns NaN for a date it cannot parse', () => {
    expect(toDayNumber('not-a-date')).toBeNaN();
    expect(toDayNumber('2026-02-30')).toBeNaN();
  });
});

describe('compareDates and daysBetween', () => {
  it('orders dates and reports the gap in whole days', () => {
    expect(compareDates('2026-08-26', TUESDAY)).toBeGreaterThan(0);
    expect(compareDates('2026-08-24', TUESDAY)).toBeLessThan(0);
    expect(compareDates(TUESDAY, TUESDAY)).toBe(0);
    expect(daysBetween(TUESDAY, '2026-10-24')).toBe(60);
    expect(daysBetween('2026-10-24', TUESDAY)).toBe(-60);
  });
});

describe('weekdayOf', () => {
  it('matches the verified week the engine suites use', () => {
    expect(weekdayOf('2026-08-24')).toBe('mon');
    expect(weekdayOf('2026-08-25')).toBe('tue');
    expect(weekdayOf('2026-08-26')).toBe('wed');
    expect(weekdayOf('2026-08-27')).toBe('thu');
    expect(weekdayOf('2026-08-28')).toBe('fri');
    expect(weekdayOf('2026-08-29')).toBe('sat');
    expect(weekdayOf('2026-08-30')).toBe('sun');
    expect(weekdayOf('2026-08-31')).toBe('mon');
  });

  it('holds far in the past, where the modulo goes negative', () => {
    expect(weekdayOf('1970-01-01')).toBe('thu');
    expect(weekdayOf('1969-12-31')).toBe('wed');
    expect(weekdayOf('1900-03-01')).toBe('thu');
  });

  it('holds far in the future', () => {
    expect(weekdayOf('2000-01-01')).toBe('sat');
    expect(weekdayOf('2100-03-01')).toBe('mon');
  });

  it('falls back to Monday rather than throwing on rubbish', () => {
    expect(weekdayOf('not-a-date')).toBe('mon');
  });
});

describe('addDays', () => {
  it('crosses a month end', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-04-30', 1)).toBe('2026-05-01');
  });

  it('crosses a year end', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('crosses a leap day in a leap year and skips it otherwise', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
  });

  it('handles negative offsets symmetrically', () => {
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDays(TUESDAY, -1)).toBe('2026-08-24');
    expect(addDays(addDays(TUESDAY, 37), -37)).toBe(TUESDAY);
  });

  it('is a no-op for zero', () => {
    expect(addDays(TUESDAY, 0)).toBe(TUESDAY);
  });

  it('spans the whole booking horizon', () => {
    expect(addDays(TUESDAY, 60)).toBe('2026-10-24');
    expect(addDays(TUESDAY, 61)).toBe('2026-10-25');
  });
});

describe('minutesOf', () => {
  it('converts HH:MM to minutes past midnight', () => {
    expect(minutesOf('00:00')).toBe(0);
    expect(minutesOf('19:00')).toBe(1140);
    expect(minutesOf('19:07')).toBe(1147);
    expect(minutesOf('23:59')).toBe(1439);
  });

  it('is NaN for 24:00, which is not a time this system has', () => {
    // A booking at "24:00" would silently become midnight the previous morning
    // if this returned 1440, so it has to be unreadable rather than clamped.
    expect(minutesOf('24:00')).toBeNaN();
  });

  it('is NaN for an impossible minute', () => {
    expect(minutesOf('12:60')).toBeNaN();
    expect(minutesOf('99:99')).toBeNaN();
  });

  it('is NaN for anything not two digits, a colon, and two digits', () => {
    expect(minutesOf('7:00')).toBeNaN();
    expect(minutesOf('19:0')).toBeNaN();
    expect(minutesOf('')).toBeNaN();
    expect(minutesOf('seven')).toBeNaN();
    expect(minutesOf('19:00:00')).toBeNaN();
  });

  it('agrees with isClockTime', () => {
    expect(isClockTime('19:00')).toBe(true);
    expect(isClockTime('24:00')).toBe(false);
    expect(isClockTime('7:00')).toBe(false);
  });
});

describe('timeFromMinutes', () => {
  it('round-trips with minutesOf across a whole day', () => {
    for (let m = 0; m < 24 * 60; m += 7) {
      expect(minutesOf(timeFromMinutes(m))).toBe(m);
    }
  });

  it('pads to HH:MM', () => {
    expect(timeFromMinutes(0)).toBe('00:00');
    expect(timeFromMinutes(65)).toBe('01:05');
    expect(timeFromMinutes(1439)).toBe('23:59');
  });

  it('clamps input outside a single day', () => {
    expect(timeFromMinutes(-1)).toBe('00:00');
    expect(timeFromMinutes(-600)).toBe('00:00');
    expect(timeFromMinutes(1440)).toBe('23:59');
    expect(timeFromMinutes(9999)).toBe('23:59');
  });

  it('rounds fractional minutes rather than truncating', () => {
    expect(timeFromMinutes(90.4)).toBe('01:30');
    expect(timeFromMinutes(90.5)).toBe('01:31');
  });
});

describe('minutesBetween', () => {
  it('is zero for the same instant and signed by direction', () => {
    expect(minutesBetween(TUESDAY, '19:00', TUESDAY, '19:00')).toBe(0);
    expect(minutesBetween(TUESDAY, '19:00', TUESDAY, '20:30')).toBe(90);
    expect(minutesBetween(TUESDAY, '20:30', TUESDAY, '19:00')).toBe(-90);
  });

  it('crosses a day boundary', () => {
    // 23:30 to 00:15 is 45 minutes, not minus 1395 — the case that catches a
    // lead-time check written against the clock instead of the calendar.
    expect(minutesBetween(TUESDAY, '23:30', '2026-08-26', '00:15')).toBe(45);
  });

  it('crosses several days, including a month end', () => {
    expect(minutesBetween('2026-08-31', '22:00', '2026-09-01', '02:00')).toBe(240);
    expect(minutesBetween(TUESDAY, '12:00', '2026-08-28', '12:00')).toBe(3 * 24 * 60);
  });
});

describe('ordinal', () => {
  it('uses st, nd, rd for 1, 2, 3', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
  });

  it('uses th for the teens, which are the exception', () => {
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
  });

  it('returns to st, nd, rd in the twenties', () => {
    expect(ordinal(21)).toBe('21st');
    expect(ordinal(22)).toBe('22nd');
    expect(ordinal(23)).toBe('23rd');
  });

  it('handles three-digit numbers, where only the last two matter', () => {
    expect(ordinal(101)).toBe('101st');
    expect(ordinal(111)).toBe('111th');
    expect(ordinal(112)).toBe('112th');
    expect(ordinal(121)).toBe('121st');
  });

  it('does not throw on zero or a negative', () => {
    expect(ordinal(0)).toBe('0th');
    expect(ordinal(-3)).toBe('3rd');
  });
});

describe('spokenDate', () => {
  it('says today and tomorrow rather than naming the day', () => {
    expect(spokenDate(TUESDAY, TUESDAY)).toBe('today');
    expect(spokenDate('2026-08-26', TUESDAY)).toBe('tomorrow');
  });

  it('names the weekday for the rest of the week', () => {
    expect(spokenDate('2026-08-27', TUESDAY)).toBe('Thursday the 27th');
    expect(spokenDate('2026-08-28', TUESDAY)).toBe('Friday the 28th');
    expect(spokenDate('2026-08-31', TUESDAY)).toBe('Monday the 31st');
  });

  it('adds the month once the weekday alone would be ambiguous', () => {
    // Seven days out, "Tuesday" would mean this Tuesday to most listeners.
    expect(spokenDate('2026-09-01', TUESDAY)).toBe('Tuesday the 1st of September');
    expect(spokenDate('2026-10-24', TUESDAY)).toBe('Saturday the 24th of October');
  });

  it('names the month for a date in the past too', () => {
    expect(spokenDate('2026-08-24', TUESDAY)).toBe('Monday the 24th of August');
  });

  it('returns the input unchanged rather than throwing on rubbish', () => {
    expect(spokenDate('not-a-date', TUESDAY)).toBe('not-a-date');
  });
});

describe('formatDateLong', () => {
  it('reads as a diary line', () => {
    expect(formatDateLong('2026-08-28')).toBe('Friday 28 August');
    expect(formatDateLong('2026-01-01')).toBe('Thursday 1 January');
    expect(formatDateLong('2024-02-29')).toBe('Thursday 29 February');
  });

  it('passes rubbish through untouched', () => {
    expect(formatDateLong('not-a-date')).toBe('not-a-date');
  });
});

describe('spokenTime', () => {
  it('drops the minutes on the hour', () => {
    expect(spokenTime('19:00')).toBe('7pm');
    expect(spokenTime('09:00')).toBe('9am');
  });

  it('uses the spoken form for half and quarter hours', () => {
    expect(spokenTime('19:30')).toBe('half past 7');
    expect(spokenTime('19:15')).toBe('quarter past 7');
    expect(spokenTime('19:45')).toBe('quarter to 8');
  });

  it('counts up to the next hour for a quarter to', () => {
    // 23:45 is a quarter to twelve, and the wrap from 11 to 12 is the only
    // place the arithmetic can go wrong.
    expect(spokenTime('23:45')).toBe('quarter to 12');
    expect(spokenTime('11:45')).toBe('quarter to 12');
    expect(spokenTime('12:45')).toBe('quarter to 1');
  });

  it('says twelve rather than zero at noon and midnight', () => {
    expect(spokenTime('12:00')).toBe('12pm');
    expect(spokenTime('00:00')).toBe('12am');
    expect(spokenTime('12:30')).toBe('half past 12');
    expect(spokenTime('00:15')).toBe('quarter past 12');
  });

  it('falls back to digits for anything else', () => {
    expect(spokenTime('19:20')).toBe('7:20pm');
    expect(spokenTime('08:05')).toBe('8:05am');
  });

  it('returns the input unchanged rather than throwing on rubbish', () => {
    expect(spokenTime('half seven')).toBe('half seven');
    expect(spokenTime('24:00')).toBe('24:00');
  });
});

describe('formatTime12', () => {
  it('writes the twelve-hour clock with a space before the suffix', () => {
    expect(formatTime12('19:00')).toBe('7:00 pm');
    expect(formatTime12('12:00')).toBe('12:00 pm');
    expect(formatTime12('00:30')).toBe('12:30 am');
    expect(formatTime12('23:59')).toBe('11:59 pm');
  });

  it('passes rubbish through untouched', () => {
    expect(formatTime12('nope')).toBe('nope');
  });
});

describe('malformed input never throws', () => {
  const rubbish = ['', 'nope', '2026-02-30', '99:99', '2026-08-25T19:00:00Z'];

  it('survives every date helper', () => {
    for (const value of rubbish) {
      expect(() => parseIsoDate(value)).not.toThrow();
      expect(() => toDayNumber(value)).not.toThrow();
      expect(() => weekdayOf(value)).not.toThrow();
      expect(() => formatDateLong(value)).not.toThrow();
      expect(() => spokenDate(value, TUESDAY)).not.toThrow();
      expect(() => compareDates(value, TUESDAY)).not.toThrow();
      expect(() => daysBetween(TUESDAY, value)).not.toThrow();
      // addDays on an unparseable date returns a nonsense string rather than
      // throwing; callers are expected to have validated first.
      expect(typeof addDays(value, 1)).toBe('string');
    }
  });

  it('survives every time helper', () => {
    for (const value of rubbish) {
      expect(() => minutesOf(value)).not.toThrow();
      expect(() => spokenTime(value)).not.toThrow();
      expect(() => formatTime12(value)).not.toThrow();
      expect(() => minutesBetween(TUESDAY, value, TUESDAY, value)).not.toThrow();
    }
    expect(() => timeFromMinutes(Number.NaN)).not.toThrow();
    expect(() => fromDayNumber(Number.NaN)).not.toThrow();
  });
});
