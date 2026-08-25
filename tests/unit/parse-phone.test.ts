/**
 * T-025. Every number here is synthetic (plan §13): the US cases use the
 * reserved `+1 415 555 01xx` range and the Indian ones are invented.
 */

import { describe, expect, it } from 'vitest';

import config from '../../src/config/restaurant.json';
import { formatPhone, lastFour, parsePhone, spokenPhone } from '../../src/agent/brains/parse/phone.js';
import type { ParseContext, ParseResult } from '../../src/agent/brains/parse/types.js';
import type { RestaurantConfig } from '../../src/engine/types.js';

const ctx: ParseContext = {
  today: '2026-08-25',
  nowTime: '18:00',
  config: config as unknown as RestaurantConfig,
};

/** Narrows before reading `.value`, so a `none` fails as a wrong kind, not a crash. */
function ok(result: ParseResult<string>): string {
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
  return result.value;
}

function none(result: ParseResult<string>): void {
  expect(result.kind).toBe('none');
}

describe('parsePhone — numerals', () => {
  it('reads a bare ten-digit mobile', () => {
    expect(ok(parsePhone('9820011234', ctx))).toBe('9820011234');
  });

  it('ignores the space people put in the middle', () => {
    expect(ok(parsePhone('98200 11234', ctx))).toBe('9820011234');
  });

  it('ignores hyphens', () => {
    expect(ok(parsePhone('982-001-1234', ctx))).toBe('9820011234');
  });

  it('keeps a country code the visitor gave', () => {
    expect(ok(parsePhone('+91 98200 11234', ctx))).toBe('919820011234');
  });

  it('drops an IDD zero prefix', () => {
    expect(ok(parsePhone('091 98200 11234', ctx))).toBe('919820011234');
  });

  it('drops a trunk zero prefix', () => {
    expect(ok(parsePhone('0 98200 11234', ctx))).toBe('9820011234');
  });

  it('does not invent a country code for a bare ten-digit number', () => {
    expect(ok(parsePhone('my number is 9820044471', ctx))).toBe('9820044471');
  });

  it('reads a US number with its country code', () => {
    expect(ok(parsePhone('+1 415 555 0142', ctx))).toBe('14155550142');
  });

  it('reads a US number written with brackets', () => {
    expect(ok(parsePhone('(415) 555-0142', ctx))).toBe('4155550142');
  });
});

describe('parsePhone — spoken', () => {
  it('reads digits spoken as words, including "oh" for zero', () => {
    expect(ok(parsePhone('nine eight two oh oh one one two three four', ctx))).toBe('9820011234');
  });

  it('honours "double"', () => {
    expect(ok(parsePhone('nine eight two double oh double one two three four', ctx))).toBe('9820011234');
  });

  it('honours "triple", including at the very start of the run', () => {
    expect(ok(parsePhone('triple two triple three one one two', ctx))).toBe('222333112');
  });

  it('handles numerals and words in the same breath', () => {
    expect(ok(parsePhone("it's 98200 double one two three four", ctx))).toBe('9820011234');
  });

  it('reads a spoken number that opens with "oh"', () => {
    expect(ok(parsePhone('oh nine eight two oh oh one one two three four', ctx))).toBe('9820011234');
  });
});

describe('parsePhone — filler', () => {
  it('strips "my number is"', () => {
    expect(ok(parsePhone('my number is 98200 11234', ctx))).toBe('9820011234');
  });

  it('strips "you can reach me on"', () => {
    expect(ok(parsePhone('you can reach me on 9820011234', ctx))).toBe('9820011234');
  });

  it("strips \"the number's\"", () => {
    expect(ok(parsePhone("the number's 9820011234", ctx))).toBe('9820011234');
  });

  it('keeps `matched` to the number rather than the sentence', () => {
    const result = parsePhone('sure, my number is 98200 11234, thanks', ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.matched).toBe('98200 11234');
  });

  it('does not read the preposition "to" as the digit 2', () => {
    expect(ok(parsePhone('you can send it to 9820011234', ctx))).toBe('9820011234');
  });

  it('takes the phone number, not the party size or the table', () => {
    expect(ok(parsePhone('table for 4 at 8, my number is 9820011234', ctx))).toBe('9820011234');
  });
});

describe('parsePhone — nothing to take', () => {
  it('returns none for an empty string', () => {
    none(parsePhone('', ctx));
  });

  it('returns none for whitespace', () => {
    none(parsePhone('   \n\t ', ctx));
  });

  it('returns none for letters only', () => {
    none(parsePhone('sorry, I would rather not say', ctx));
  });

  it('returns none for a bare count', () => {
    none(parsePhone("there'll be 4 of us", ctx));
  });

  it('returns none for a time', () => {
    none(parsePhone("let's say 7:30", ctx));
  });

  it('returns none for a 24-hour time, which is four digits', () => {
    none(parsePhone('19:30 please', ctx));
  });

  it('returns none for a day/month date', () => {
    none(parsePhone("we'll come on 28/8", ctx));
  });

  it('returns none for a full slash date', () => {
    none(parsePhone('28/08/2026 if possible', ctx));
  });

  it('returns none for an ISO date', () => {
    none(parsePhone('2026-08-25', ctx));
  });
});

describe('parsePhone — pass-through, because length is the validator is the one that says no', () => {
  it('returns a four-digit run so the validator can call it too short', () => {
    expect(ok(parsePhone('my number is 1234', ctx))).toBe('1234');
  });

  it('returns the last four digits given as a repair', () => {
    expect(ok(parsePhone('four four seven one', ctx))).toBe('4471');
  });

  it('returns a forty-digit run so the validator can call it too long', () => {
    const forty = '1234567890'.repeat(4);
    expect(ok(parsePhone(forty, ctx))).toBe(forty);
  });

  it('keeps an all-zero run intact rather than normalising it away', () => {
    expect(ok(parsePhone('0000', ctx))).toBe('0000');
  });
});

describe('parsePhone — hostile input', () => {
  it('does not throw on ten thousand letters', () => {
    expect(() => parsePhone('a'.repeat(10_000), ctx)).not.toThrow();
    none(parsePhone('a'.repeat(10_000), ctx));
  });

  it('does not throw on ten thousand digits', () => {
    expect(ok(parsePhone('9'.repeat(10_000), ctx))).toHaveLength(10_000);
  });

  it('does not throw on ten thousand separators', () => {
    expect(() => parsePhone('-+ '.repeat(3_333), ctx)).not.toThrow();
  });

  it('does not throw on punctuation soup', () => {
    expect(() => parsePhone('!!! ((( ))) ??? +++ ...', ctx)).not.toThrow();
  });
});

describe('formatPhone', () => {
  it('groups a ten-digit Indian mobile', () => {
    expect(formatPhone('9820011234')).toBe('98200 11234');
  });

  it('groups a twelve-digit number carrying 91', () => {
    expect(formatPhone('919820011234')).toBe('+91 98200 11234');
  });

  it('groups an eleven-digit number carrying 1', () => {
    expect(formatPhone('14155550142')).toBe('+1 415 555 0142');
  });

  it('groups a bare US ten-digit number the US way', () => {
    expect(formatPhone('4155550142')).toBe('415 555 0142');
  });

  it('falls back to 3s and 4s for anything else', () => {
    expect(formatPhone('9820011')).toBe('9820 011');
    expect(formatPhone('982001123')).toBe('982 001 123');
  });

  it('tolerates already-formatted input', () => {
    expect(formatPhone('+91 98200 11234')).toBe('+91 98200 11234');
  });

  it('returns an empty string for nothing, and never throws', () => {
    expect(formatPhone('')).toBe('');
    expect(formatPhone('no digits here')).toBe('');
    expect(() => formatPhone('1234567890'.repeat(4))).not.toThrow();
  });
});

describe('spokenPhone', () => {
  it('separates every digit so it is not read as one huge integer', () => {
    expect(spokenPhone('9820011234')).toBe('9 8 2 0 0, 1 1 2 3 4');
  });

  it('says the country code as "plus"', () => {
    expect(spokenPhone('919820011234')).toBe('plus 9 1, 9 8 2 0 0, 1 1 2 3 4');
    expect(spokenPhone('14155550142')).toBe('plus 1, 4 1 5, 5 5 5, 0 1 4 2');
  });

  it('never leaves two digits adjacent', () => {
    expect(spokenPhone('1234567890'.repeat(4))).not.toMatch(/\d\d/);
  });

  it('returns an empty string for nothing', () => {
    expect(spokenPhone('')).toBe('');
    expect(spokenPhone('nothing')).toBe('');
  });
});

describe('lastFour', () => {
  it('returns the tail used by the read-back', () => {
    expect(lastFour('9820044471')).toBe('4471');
  });

  it('ignores formatting', () => {
    expect(lastFour('+91 98200 44471')).toBe('4471');
  });

  it('returns fewer than four for a short number', () => {
    expect(lastFour('12')).toBe('12');
  });

  it('returns an empty string for nothing', () => {
    expect(lastFour('')).toBe('');
    expect(lastFour('letters')).toBe('');
  });
});
