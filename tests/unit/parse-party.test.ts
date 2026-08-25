/**
 * T-023. The party parser's job is to understand, not to permit: 0, 40 and -3
 * all parse, and are refused a layer up by `src/engine/validate.ts`. Half of
 * these cases exist to prove that a time, a date or a phone number never comes
 * back as a number of people.
 */

import { describe, expect, it } from 'vitest';

import config from '../../src/config/restaurant.json';
import { parseParty } from '../../src/agent/brains/parse/party.js';
import type { ParseContext } from '../../src/agent/brains/parse/types.js';
import type { RestaurantConfig } from '../../src/engine/types.js';

const ctx: ParseContext = {
  today: '2026-08-25',
  nowTime: '18:00',
  config: config as unknown as RestaurantConfig,
};

/** Phrasings that resolve to exactly one count. */
const COUNTS: ReadonlyArray<readonly [string, number]> = [
  // Bare numbers, words and digits.
  ['four', 4],
  ['4', 4],
  ['eight', 8],
  ['for four', 4],
  ['a table for four', 4],
  ['table for 4', 4],
  ['four of us', 4],
  ['there are four of us', 4],
  ['party of six', 6],
  ['six people', 6],
  ['six guests', 6],
  ["we're six", 6],
  ['we are 3 adults', 3],
  ['group of ten', 10],
  ['we are twenty five', 25],
  ['twenty two people', 22],

  // One.
  ['just me', 1],
  ['myself', 1],
  ['only me', 1],
  ['me alone', 1],
  ['one person', 1],
  ['solo', 1],
  ['a table for one', 1],

  // Two.
  ['me and my wife', 2],
  ['my husband and i', 2],
  ['two of us', 2],
  ['couple', 2],
  ['a couple of us', 2],
  ['for two', 2],

  // Hedged counts: the hedge is not a value, so it is dropped.
  ['about six', 6],
  ['around six', 6],
  ['six-ish', 6],
  ['roughly six of us', 6],

  // Idioms.
  ['a dozen', 12],
  ['half a dozen', 6],

  // Buried in a real sentence, alongside a date and a time.
  ['do you have a table for four on friday at seven', 4],
  ['a table for four at 7:30 on the 28th', 4],
  ['hi there, could we get a table for six on saturday evening please', 6],

  // Values the parser must pass through untouched: policy lives in the engine.
  ['party of forty', 40],
  ['party of zero', 0],
  ['zero', 0],
  ['a table for 8', 8],

  // Corrections. "actually" / "make it" / "sorry" replace, they do not offer.
  ['four — actually, make it five', 5],
  ['six people. sorry, five people', 5],
  ['party of four, no wait, six', 6],
  ['a table for four and five', 5],

  // Two counts of people joined by "and" are one party.
  ['four adults and two kids', 6],
  ['two adults and two children', 4],
  ['just me and my wife', 2],
];

/** Phrasings where two readings are live and guessing would be a lie (R-03). */
const RANGES: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['four or five', [4, 5]],
  ['four to five', [4, 5]],
  ['maybe four or five', [4, 5]],
  ['four, maybe five', [4, 5]],
  ['four or five of us', [4, 5]],
  ['a table for four or five please', [4, 5]],
];

/** Numbers that are not people. */
const NOT_A_PARTY: readonly string[] = [
  'at seven',
  'seven pm',
  'half seven',
  '7:30',
  'quarter past eight',
  'eight o\'clock',
  'the 28th',
  '28 august',
  'august 28',
  'the twenty-eighth',
  'friday',
  'next friday evening',
  '9876543210',
  'my number is 98765 43210',
  '+91 98765 43210',
  'in ten minutes',
  'in a couple of hours',
  'hello',
  '',
  '   ',
];

describe('parseParty', () => {
  for (const [text, expected] of COUNTS) {
    it(`reads "${text}" as ${expected}`, () => {
      const result = parseParty(text, ctx);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value).toBe(expected);
      expect(result.matched.length).toBeGreaterThan(0);
    });
  }

  for (const [text, candidates] of RANGES) {
    it(`asks rather than guesses for "${text}"`, () => {
      const result = parseParty(text, ctx);
      expect(result.kind).toBe('ambiguous');
      if (result.kind !== 'ambiguous') return;
      expect([...result.candidates]).toEqual([...candidates]);
      expect(result.note.length).toBeGreaterThan(0);
    });
  }

  for (const text of NOT_A_PARTY) {
    it(`finds no party size in "${text}"`, () => {
      expect(parseParty(text, ctx).kind).toBe('none');
    });
  }

  describe('values the validator rejects, not the parser', () => {
    it('parses a party of forty rather than clamping it to maxPartySize', () => {
      const result = parseParty('party of forty', ctx);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value).toBe(40);
      expect(result.value).toBeGreaterThan(ctx.config.service.maxPartySize);
    });

    it('parses zero rather than treating it as unparseable', () => {
      const result = parseParty('party of zero', ctx);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value).toBe(0);
      expect(result.value).toBeLessThan(ctx.config.service.minPartySize);
    });

    it('parses "minus three" as -3', () => {
      const result = parseParty('minus three', ctx);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value).toBe(-3);
    });

    it('parses "-3" as -3', () => {
      const result = parseParty('-3', ctx);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value).toBe(-3);
    });

    it('does not confuse a phone number with a party size', () => {
      expect(parseParty('you can reach me on +91 98765 43210', ctx).kind).toBe('none');
    });

    it('parses a negative buried in a proposal', () => {
      const result = parseParty('table for -3', ctx);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value).toBe(-3);
    });
  });

  describe('homophones from the recogniser', () => {
    it('does not read the "for" in "a table for six" as a four', () => {
      const result = parseParty('a table for six', ctx);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value).toBe(6);
    });

    it('does not read the "to" in "four to five" as a two', () => {
      const result = parseParty('four to five', ctx);
      expect(result.kind).toBe('ambiguous');
      if (result.kind !== 'ambiguous') return;
      expect([...result.candidates]).toEqual([4, 5]);
    });
  });

  describe('purity', () => {
    it('returns the same result for the same input', () => {
      expect(parseParty('four or five of us', ctx)).toEqual(parseParty('four or five of us', ctx));
    });

    it('ignores the conversation context, which carries no party information', () => {
      const withDate: ParseContext = { ...ctx, date: '2026-08-28' };
      expect(parseParty('party of six', withDate)).toEqual(parseParty('party of six', ctx));
    });
  });
});
