import { describe, expect, it } from 'vitest';

import { parseDate } from '../../src/agent/brains/parse/date.js';
import type { ParseContext, ParseResult } from '../../src/agent/brains/parse/types.js';
import { weekdayOf } from '../../src/engine/time.js';
import type { ClockTime, IsoDate, RestaurantConfig } from '../../src/engine/types.js';
import config from '../../src/config/restaurant.json';

const RESTAURANT = config as unknown as RestaurantConfig;

/** 2026-08-25 is a Tuesday — asserted below rather than assumed. */
const TODAY: IsoDate = '2026-08-25';

function ctxOn(today: IsoDate, nowTime: ClockTime = '18:00'): ParseContext {
  return { today, nowTime, config: RESTAURANT };
}

const ctx = ctxOn(TODAY);

function expectDate(result: ParseResult<IsoDate>, expected: IsoDate): void {
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') return;
  expect(result.value).toBe(expected);
}

function expectCandidates(result: ParseResult<IsoDate>, expected: readonly IsoDate[]): void {
  expect(result.kind).toBe('ambiguous');
  if (result.kind !== 'ambiguous') return;
  expect(result.candidates).toEqual(expected);
  expect(result.note.length).toBeGreaterThan(0);
}

describe('fixture assumptions', () => {
  it('pins today to a Tuesday', () => {
    expect(weekdayOf(TODAY)).toBe('tue');
  });

  it('pins the other fixture dates used below', () => {
    expect(weekdayOf('2026-08-28')).toBe('fri');
    expect(weekdayOf('2026-08-29')).toBe('sat');
    expect(weekdayOf('2026-08-30')).toBe('sun');
    expect(weekdayOf('2026-08-31')).toBe('mon');
    expect(weekdayOf('2026-09-25')).toBe('fri');
  });
});

describe('parseDate — relative days', () => {
  it('today', () => {
    expectDate(parseDate('today', ctx), '2026-08-25');
  });

  it('tonight, however late it already is', () => {
    expectDate(parseDate('tonight', ctxOn(TODAY, '23:45')), '2026-08-25');
  });

  it('this evening', () => {
    expectDate(parseDate('this evening', ctx), '2026-08-25');
  });

  it('tomorrow', () => {
    expectDate(parseDate('tomorrow', ctx), '2026-08-26');
  });

  it('tomorrow evening, keeping the part of day in the match', () => {
    const result = parseDate('tomorrow evening', ctx);
    expectDate(result, '2026-08-26');
    if (result.kind === 'ok') expect(result.matched).toBe('tomorrow evening');
  });

  it('day after tomorrow', () => {
    expectDate(parseDate('day after tomorrow', ctx), '2026-08-27');
  });

  it('the day after tomorrow evening beats the tomorrow inside it', () => {
    expectDate(parseDate('the day after tomorrow evening', ctx), '2026-08-27');
  });

  it('yesterday parses; rejecting the past is the validator’s job', () => {
    expectDate(parseDate('yesterday', ctx), '2026-08-24');
  });
});

describe('parseDate — weekdays', () => {
  it('a bare weekday resolves to the next occurrence', () => {
    expectDate(parseDate('friday', ctx), '2026-08-28');
  });

  it('accepts the short form', () => {
    expectDate(parseDate('fri', ctx), '2026-08-28');
  });

  it('finds a weekday inside a whole sentence', () => {
    const result = parseDate('do you have a table for four on friday', ctx);
    expectDate(result, '2026-08-28');
    if (result.kind === 'ok') expect(result.matched).toBe('on friday');
  });

  it('today’s own weekday means today while the kitchen is still open', () => {
    expectDate(parseDate('tuesday', ctxOn(TODAY, '18:00')), '2026-08-25');
  });

  it('today’s own weekday means next week once service has ended', () => {
    // Tuesday's last window closes at 22:30.
    expectDate(parseDate('tuesday', ctxOn(TODAY, '23:00')), '2026-09-01');
  });

  it('a closed day never resolves to today', () => {
    // Monday the 31st; the restaurant is shut on Mondays.
    expectDate(parseDate('monday', ctxOn('2026-08-31')), '2026-09-07');
  });

  it('friday said on a Friday afternoon means that Friday', () => {
    expectDate(parseDate('friday', ctxOn('2026-08-28', '18:00')), '2026-08-28');
  });

  it('friday said after Friday’s last window means the next one', () => {
    expectDate(parseDate('friday', ctxOn('2026-08-28', '23:30')), '2026-09-04');
  });

  it('sunday', () => {
    expectDate(parseDate('sunday', ctx), '2026-08-30');
  });

  it('this friday reads as the near one', () => {
    expectDate(parseDate('this friday', ctx), '2026-08-28');
  });

  it('next friday skips into the following calendar week', () => {
    expectDate(parseDate('next friday', ctx), '2026-09-04');
  });

  it('next friday said on a Friday is ten days out', () => {
    expectDate(parseDate('next friday', ctxOn('2026-08-28')), '2026-09-04');
  });
});

describe('parseDate — spans that are questions, not answers', () => {
  it('this weekend offers both days', () => {
    expectCandidates(parseDate('this weekend', ctx), ['2026-08-29', '2026-08-30']);
  });

  it('a bare weekend behaves the same', () => {
    expectCandidates(parseDate('are you open at the weekend', ctx), ['2026-08-29', '2026-08-30']);
  });

  it('this weekend said on the Saturday includes that Saturday', () => {
    expectCandidates(parseDate('this weekend', ctxOn('2026-08-29')), ['2026-08-29', '2026-08-30']);
  });

  it('this weekend said on the Sunday reads forward', () => {
    expectCandidates(parseDate('this weekend', ctxOn('2026-08-30')), ['2026-09-05', '2026-09-06']);
  });

  it('next weekend', () => {
    expectCandidates(parseDate('next weekend', ctx), ['2026-09-05', '2026-09-06']);
  });

  it('next week offers the seven days of the following week', () => {
    const result = parseDate('next week', ctx);
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates).toHaveLength(7);
    expect(result.candidates[0]).toBe('2026-08-31');
    expect(result.candidates[6]).toBe('2026-09-06');
  });
});

describe('parseDate — offsets', () => {
  it('in three days', () => {
    expectDate(parseDate('in three days', ctx), '2026-08-28');
  });

  it('in 3 days', () => {
    expectDate(parseDate('in 3 days', ctx), '2026-08-28');
  });

  it('in a week', () => {
    expectDate(parseDate('in a week', ctx), '2026-09-01');
  });

  it('in two weeks', () => {
    expectDate(parseDate('in two weeks', ctx), '2026-09-08');
  });

  it('in a fortnight', () => {
    expectDate(parseDate('in a fortnight', ctx), '2026-09-08');
  });

  it('in twenty-five days, crossing a month boundary', () => {
    expectDate(parseDate('in twenty-five days', ctx), '2026-09-19');
  });
});

describe('parseDate — day of month', () => {
  it('the 28th', () => {
    const result = parseDate('the 28th', ctx);
    expectDate(result, '2026-08-28');
    if (result.kind === 'ok') expect(result.matched).toBe('the 28th');
  });

  it('a bare 28th', () => {
    expectDate(parseDate('28th', ctx), '2026-08-28');
  });

  it('on the twenty-eighth', () => {
    expectDate(parseDate('on the twenty-eighth', ctx), '2026-08-28');
  });

  it('the twenty eighth, unhyphenated', () => {
    expectDate(parseDate('the twenty eighth', ctx), '2026-08-28');
  });

  it('a day already gone rolls into next month', () => {
    expectDate(parseDate('the 3rd', ctx), '2026-09-03');
  });

  it('the 1st crosses the month boundary', () => {
    expectDate(parseDate('the 1st', ctx), '2026-09-01');
  });

  it('today’s date means today while the kitchen is still open', () => {
    expectDate(parseDate('the 25th', ctxOn(TODAY, '18:00')), '2026-08-25');
  });

  it('today’s date means next month once service has ended', () => {
    expectDate(parseDate('the 25th', ctxOn(TODAY, '23:00')), '2026-09-25');
  });

  it('the 31st skips a thirty-day month', () => {
    // 2026-09-25 is a Friday in a thirty-day month.
    expectDate(parseDate('the 31st', ctxOn('2026-09-25')), '2026-10-31');
  });

  it('a day no month contains is not understood', () => {
    expect(parseDate('the 35th', ctx).kind).toBe('none');
  });
});

describe('parseDate — named months', () => {
  it('28 august', () => {
    expectDate(parseDate('28 august', ctx), '2026-08-28');
  });

  it('august 28', () => {
    expectDate(parseDate('august 28', ctx), '2026-08-28');
  });

  it('28th of august', () => {
    expectDate(parseDate('28th of august', ctx), '2026-08-28');
  });

  it('aug 28', () => {
    expectDate(parseDate('aug 28', ctx), '2026-08-28');
  });

  it('an explicit year is honoured', () => {
    expectDate(parseDate('28 august 2027', ctx), '2027-08-28');
  });

  it('a month and day already past resolve to next year', () => {
    expectDate(parseDate('5 january', ctx), '2027-01-05');
  });

  it('february 29 finds the next leap year', () => {
    expectDate(parseDate('february 29', ctx), '2028-02-29');
  });

  it('february 30 exists in no year', () => {
    expect(parseDate('february 30', ctx).kind).toBe('none');
  });

  it('june is not read as jun plus a stray e', () => {
    expectDate(parseDate('12 june', ctx), '2027-06-12');
  });
});

describe('parseDate — numeric forms', () => {
  it('28/8 is day-first', () => {
    expectDate(parseDate('28/8', ctx), '2026-08-28');
  });

  it('28-08', () => {
    expectDate(parseDate('28-08', ctx), '2026-08-28');
  });

  it('28/08/2026', () => {
    const result = parseDate('28/08/2026', ctx);
    expectDate(result, '2026-08-28');
    if (result.kind === 'ok') expect(result.matched).toBe('28/08/2026');
  });

  it('a two-digit year is this century', () => {
    expectDate(parseDate('28/08/26', ctx), '2026-08-28');
  });

  it('8/9 takes the en-IN reading', () => {
    expectDate(parseDate('8/9', ctx), '2026-09-08');
  });

  it('08/28 has no day-first reading, so it is read month-first', () => {
    expectDate(parseDate('08/28', ctx), '2026-08-28');
  });

  it('13/13 is not a date', () => {
    expect(parseDate('13/13', ctx).kind).toBe('none');
  });

  it('an ISO date passes straight through', () => {
    expectDate(parseDate('2026-08-28', ctx), '2026-08-28');
  });

  it('an ISO date in the past is still reported', () => {
    expectDate(parseDate('2026-08-20', ctx), '2026-08-20');
  });

  it('an ISO date the calendar does not contain is refused', () => {
    expect(parseDate('2026-02-30', ctx).kind).toBe('none');
  });

  it('an ISO date is not mistaken for a day/month pair', () => {
    expectDate(parseDate('2026-12-31', ctx), '2026-12-31');
  });
});

describe('parseDate — weekday and day together', () => {
  it('friday the 28th', () => {
    expectDate(parseDate('friday the 28th', ctx), '2026-08-28');
  });

  it('a combination that cannot occur within the horizon is refused', () => {
    // The next Friday the 31st is years away; 60 days holds neither.
    expect(parseDate('friday the 31st', ctx).kind).toBe('none');
  });

  it('a disagreeing combination is not quietly reduced to the weekday', () => {
    const result = parseDate('saturday the 28th', ctx);
    expect(result.kind).toBe('none');
  });
});

describe('parseDate — picking between mentions', () => {
  it('prefers the last date in the sentence', () => {
    expectDate(parseDate('thursday, sorry, friday', ctx), '2026-08-28');
  });

  it('prefers the correction even across forms', () => {
    expectDate(parseDate('the 3rd — no, make it the 28th', ctx), '2026-08-28');
  });

  it('finds a date at the end of a long sentence', () => {
    expectDate(parseDate('hi there, could we get a table for two on the 28th please', ctx), '2026-08-28');
  });
});

describe('parseDate — nothing to hear', () => {
  it('empty input', () => {
    expect(parseDate('', ctx).kind).toBe('none');
  });

  it('whitespace only', () => {
    expect(parseDate('   ', ctx).kind).toBe('none');
  });

  it('gibberish', () => {
    expect(parseDate('blorp wug frotz', ctx).kind).toBe('none');
  });

  it('a party size is not a date', () => {
    expect(parseDate('a table for four', ctx).kind).toBe('none');
  });

  it('a time is not a date', () => {
    expect(parseDate('half past seven please', ctx).kind).toBe('none');
  });
});

describe('parseDate — calendar boundaries', () => {
  it('tomorrow crosses a month end', () => {
    expectDate(parseDate('tomorrow', ctxOn('2026-08-31')), '2026-09-01');
  });

  it('tomorrow crosses a year end', () => {
    expectDate(parseDate('tomorrow', ctxOn('2026-12-31')), '2027-01-01');
  });

  it('tomorrow lands on a leap day', () => {
    expectDate(parseDate('tomorrow', ctxOn('2028-02-28')), '2028-02-29');
  });

  it('next week crosses a year end', () => {
    const result = parseDate('next week', ctxOn('2026-12-31'));
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates[0]).toBe('2027-01-04');
  });
});
