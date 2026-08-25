/**
 * T-022. The interesting half of this file is the bare-number cases: "seven"
 * means 19:00 on a dinner-only Tuesday and 19:00 on a Friday that also serves
 * lunch, and both of those have to come out of the shipped config rather than
 * out of a hardcoded preference for the evening.
 */

import { describe, expect, it } from 'vitest';

import rawConfig from '../../src/config/restaurant.json';
import { parseTime } from '../../src/agent/brains/parse/time.js';
import type { ParseContext, ParseResult } from '../../src/agent/brains/parse/types.js';
import type { ClockTime, OpeningDay, RestaurantConfig } from '../../src/engine/types.js';
import { weekdayOf } from '../../src/engine/time.js';

const config = rawConfig as RestaurantConfig;

/** Pinned. Which weekday these are is asserted below rather than assumed. */
const TUESDAY = '2026-08-25';
const WEDNESDAY = '2026-08-26';
const FRIDAY = '2026-08-28';
const MONDAY = '2026-08-24';

const base: ParseContext = { today: TUESDAY, nowTime: '18:00', config };

const on = (date: string): ParseContext => ({ ...base, date });

function expectTime(result: ParseResult<ClockTime>, expected: ClockTime): void {
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') return;
  expect(result.value).toBe(expected);
}

/** A restaurant that also does breakfast, so a bare seven is genuinely two times. */
const breakfastTuesday: OpeningDay = {
  day: 'tue',
  windows: [
    ['07:00', '10:00'],
    ['18:30', '22:30'],
  ],
};
const breakfastConfig: RestaurantConfig = {
  ...config,
  hours: config.hours.map((day) => (day.day === 'tue' ? breakfastTuesday : day)),
};

describe('fixture dates', () => {
  it('are the weekdays the rest of this file relies on', () => {
    expect(weekdayOf(MONDAY)).toBe('mon');
    expect(weekdayOf(TUESDAY)).toBe('tue');
    expect(weekdayOf(WEDNESDAY)).toBe('wed');
    expect(weekdayOf(FRIDAY)).toBe('fri');
  });
});

describe('parseTime — explicit clock forms', () => {
  it('reads "7pm"', () => {
    expectTime(parseTime('7pm', base), '19:00');
  });

  it('reads "7 pm" with the marker split off', () => {
    expectTime(parseTime('7 pm', base), '19:00');
  });

  it('reads "7:30pm"', () => {
    expectTime(parseTime('7:30pm', base), '19:30');
  });

  it('reads "7.30pm"', () => {
    expectTime(parseTime('7.30pm', base), '19:30');
  });

  it('reads "7:30 p.m." with dotted meridiem', () => {
    expectTime(parseTime("we'd like 7:30 p.m.", base), '19:30');
  });

  it('reads 24-hour "19:30"', () => {
    expectTime(parseTime('19:30', base), '19:30');
  });

  it('reads 24-hour "19.30"', () => {
    expectTime(parseTime('19.30', base), '19:30');
  });

  it('reads compact "1930"', () => {
    expectTime(parseTime('1930', base), '19:30');
  });

  it('reads a bare 24-hour hour "at 19"', () => {
    expectTime(parseTime('at 19', base), '19:00');
  });

  it('keeps an explicit morning time even though the kitchen is shut then', () => {
    expectTime(parseTime('9am', on(TUESDAY)), '09:00');
  });
});

describe('parseTime — spoken forms', () => {
  it('reads "seven thirty"', () => {
    expectTime(parseTime('seven thirty', on(TUESDAY)), '19:30');
  });

  it('reads "seven fifteen"', () => {
    expectTime(parseTime('seven fifteen', on(TUESDAY)), '19:15');
  });

  it('reads "seven forty five"', () => {
    expectTime(parseTime('seven forty five', on(TUESDAY)), '19:45');
  });

  it('reads British "half seven" as 19:30, not 06:30', () => {
    expectTime(parseTime('half seven', on(TUESDAY)), '19:30');
  });

  it('reads "half past seven"', () => {
    expectTime(parseTime('half past seven', on(TUESDAY)), '19:30');
  });

  it('reads "quarter past eight"', () => {
    expectTime(parseTime('quarter past eight', on(TUESDAY)), '20:15');
  });

  it('reads "a quarter to eight" as 19:45', () => {
    expectTime(parseTime('a quarter to eight', on(TUESDAY)), '19:45');
  });

  it('reads "twenty past seven"', () => {
    expectTime(parseTime('twenty past seven', on(TUESDAY)), '19:20');
  });

  it('reads "ten to eight"', () => {
    expectTime(parseTime('ten to eight', on(TUESDAY)), '19:50');
  });

  it('reads "seven o\'clock"', () => {
    expectTime(parseTime("seven o'clock", on(TUESDAY)), '19:00');
  });

  it('reads "eight o\'clock pm" with a redundant marker', () => {
    expectTime(parseTime("eight o'clock pm", base), '20:00');
  });

  it('reads "noon"', () => {
    expectTime(parseTime('noon', base), '12:00');
  });

  it('reads "midday"', () => {
    expectTime(parseTime('midday', base), '12:00');
  });

  it('reads "midnight"', () => {
    expectTime(parseTime('midnight', base), '00:00');
  });
});

describe('parseTime — hedges are stripped, not interpreted', () => {
  it('reads "around 8" as 20:00 and matches only the number', () => {
    const result = parseTime('around 8', on(TUESDAY));
    expectTime(result, '20:00');
    if (result.kind === 'ok') expect(result.matched).toBe('8');
  });

  it('reads "about eight"', () => {
    expectTime(parseTime('about eight', on(TUESDAY)), '20:00');
  });

  it('reads "8ish"', () => {
    expectTime(parseTime('8ish', on(TUESDAY)), '20:00');
  });

  it('reads "sometime around 8"', () => {
    expectTime(parseTime('sometime around 8', on(TUESDAY)), '20:00');
  });
});

describe('parseTime — a service is not a time', () => {
  it('refuses "in the evening"', () => {
    expect(parseTime('in the evening', on(TUESDAY)).kind).toBe('none');
  });

  it('refuses "for dinner"', () => {
    expect(parseTime('for dinner', on(TUESDAY)).kind).toBe('none');
  });

  it('refuses "for lunch"', () => {
    expect(parseTime('for lunch', on(FRIDAY)).kind).toBe('none');
  });

  it('refuses "early"', () => {
    expect(parseTime('early', on(TUESDAY)).kind).toBe('none');
  });

  it('refuses "late"', () => {
    expect(parseTime('as late as you can do', on(TUESDAY)).kind).toBe('none');
  });
});

describe('parseTime — nonsense', () => {
  it('refuses "25pm"', () => {
    expect(parseTime('25pm', base).kind).toBe('none');
  });

  it('refuses "13pm"', () => {
    expect(parseTime('13pm', base).kind).toBe('none');
  });

  it('refuses minutes past 59', () => {
    expect(parseTime('7:70', base).kind).toBe('none');
  });

  it('refuses "half past" with no hour', () => {
    expect(parseTime('half past', on(TUESDAY)).kind).toBe('none');
  });

  it('refuses "quarter to" with no hour', () => {
    expect(parseTime('quarter to', on(TUESDAY)).kind).toBe('none');
  });

  it('refuses an empty utterance', () => {
    expect(parseTime('', base).kind).toBe('none');
  });

  it('refuses gibberish', () => {
    expect(parseTime('mmm hold on a sec', base).kind).toBe('none');
  });
});

describe('parseTime — bare numbers against real service windows', () => {
  it('resolves a bare "7" to 19:00 on a dinner-only Tuesday', () => {
    expectTime(parseTime('7', on(TUESDAY)), '19:00');
  });

  it('resolves a bare "seven" to 19:00 on a dinner-only Wednesday', () => {
    expectTime(parseTime('seven', on(WEDNESDAY)), '19:00');
  });

  it('resolves a bare "7:30" to 19:30', () => {
    expectTime(parseTime('7:30', on(TUESDAY)), '19:30');
  });

  it('resolves a bare "1" to 13:00 on Friday, which serves lunch', () => {
    expectTime(parseTime('1', on(FRIDAY)), '13:00');
  });

  it('resolves a bare "7" to 19:00 on Friday, because 07:00 is in no window', () => {
    expectTime(parseTime('7', on(FRIDAY)), '19:00');
  });

  it('resolves "12:30" to lunchtime on Friday rather than half past midnight', () => {
    expectTime(parseTime('12:30', on(FRIDAY)), '12:30');
  });

  it('resolves compact "730" the same way a bare 7:30 resolves', () => {
    expectTime(parseTime('730', on(TUESDAY)), '19:30');
  });

  it('falls back to every window the restaurant opens when no date is settled', () => {
    expectTime(parseTime('seven', base), '19:00');
  });

  it('uses the same fallback on a closed Monday, which implies nothing on its own', () => {
    expectTime(parseTime('seven', on(MONDAY)), '19:00');
  });

  it('asks rather than guesses when both readings are in service', () => {
    const result = parseTime('seven', { ...base, date: TUESDAY, config: breakfastConfig });
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates).toEqual(['07:00', '19:00']);
    expect(result.note).toContain('7am');
  });

  it('returns the nearest out-of-hours reading so the validator can quote the hours', () => {
    // 05:30 and 17:30 are both shut on a Tuesday; 17:30 is an hour off service,
    // 05:30 is thirteen. Saying "we open at half six" beats "I didn't catch that".
    expectTime(parseTime('half five', on(TUESDAY)), '17:30');
  });

  it('honours an explicit part of the day over the windows', () => {
    expectTime(parseTime('seven in the morning', on(TUESDAY)), '07:00');
  });
});

describe('parseTime — times inside longer sentences', () => {
  it('finds "half seven" in a booking request', () => {
    const result = parseTime('friday at half seven for four of us', on(FRIDAY));
    expectTime(result, '19:30');
    if (result.kind === 'ok') expect(result.matched).toBe('half seven');
  });

  it('takes the last mention when the visitor corrects themselves', () => {
    expectTime(parseTime('seven, no, eight pm', on(TUESDAY)), '20:00');
  });

  it('takes the later of two explicit times', () => {
    expectTime(parseTime('7pm or 8pm, whichever you have', on(TUESDAY)), '20:00');
  });

  it('ignores the day-of-month number', () => {
    expectTime(parseTime('the 28th at 8pm', on(FRIDAY)), '20:00');
  });
});

describe('parseTime — numbers that are not times', () => {
  it('ignores a party size after "table for"', () => {
    expect(parseTime('a table for four', on(TUESDAY)).kind).toBe('none');
  });

  it('ignores a party size after "party of"', () => {
    expect(parseTime('party of six please', on(TUESDAY)).kind).toBe('none');
  });

  it('still reads a time after "for" when it carries a marker', () => {
    expectTime(parseTime('can you do a table for 8pm', on(TUESDAY)), '20:00');
  });

  it('ignores a long digit run', () => {
    expect(parseTime('my number is 09821115566', base).kind).toBe('none');
  });

  it('ignores a phone number dictated in groups', () => {
    expect(parseTime('0982 211 5566', base).kind).toBe('none');
  });

  it('finds the time even when a party size comes first', () => {
    expectTime(parseTime('table for four at 8', on(TUESDAY)), '20:00');
  });
});
