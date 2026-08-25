/**
 * The phrase inventory (T-080).
 *
 * Two failures this file exists to prevent, both of which are silent until a
 * visitor hears them:
 *
 *   - **A key with no words.** `PhraseKey` is a union in `src/engine/types.ts`
 *     and `PHRASES` is a map in `src/config/phrases.ts`. TypeScript will catch a
 *     key added to the map but missing from the union; it will *not* catch the
 *     other direction if the map is ever widened. So the union is re-read from
 *     the source text here and compared to the map.
 *   - **A visible `{placeholder}`.** The agent saying "under {name}" out loud is
 *     the single most demo-destroying bug available, so the substitution and its
 *     whitespace tidying are asserted over every line rather than spot-checked.
 *
 * The style rules from plan §5.4 are enforced as assertions rather than left to
 * review, because copy is exactly the thing that gets changed in a hurry.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PHRASES, allPhraseKeys, bakeablePhrases, isBakeable, renderPhrase, variantFor } from '../../src/config/phrases.js';
import type { PhraseKey } from '../../src/engine/types.js';

const KEYS: readonly PhraseKey[] = allPhraseKeys();
const VARIANTS: ReadonlyArray<{ key: PhraseKey; variant: number; text: string }> = KEYS.flatMap((key) =>
  PHRASES[key].map((text, variant) => ({ key, variant, text })),
);

/**
 * The `PhraseKey` union, read out of the source rather than out of the type.
 *
 * A type cannot be enumerated at runtime, and that is precisely the gap a key
 * added to the union and forgotten in the map would slip through.
 */
function keysDeclaredInTypes(): readonly string[] {
  const source = readFileSync(new URL('../../src/engine/types.ts', import.meta.url), 'utf8');
  const union = /export type PhraseKey =([\s\S]*?);/.exec(source);
  if (union === null) throw new Error('could not find the PhraseKey union in src/engine/types.ts');
  return [...(union[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

describe('phrase coverage', () => {
  it('gives every PhraseKey in the union at least one wording', () => {
    const declared = keysDeclaredInTypes();
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...KEYS].sort());
  });

  it('has no empty variant lists and no empty strings', () => {
    for (const key of KEYS) {
      expect(PHRASES[key].length, `${key} has no variants`).toBeGreaterThan(0);
      for (const text of PHRASES[key]) expect(text.trim(), `${key} has a blank variant`).not.toBe('');
    }
  });

  it('meets the inventory size T-080 asks for', () => {
    expect(KEYS.length).toBeGreaterThanOrEqual(25);
  });
});

describe('the voice (plan §5.4)', () => {
  it('never uses an exclamation mark', () => {
    for (const { key, text } of VARIANTS) {
      expect(text, `${key}: "${text}"`).not.toContain('!');
    }
  });

  it('is at most two sentences', () => {
    // A latency rule as much as a style one: the first sentence is what reaches
    // audio first, and a short one reaches it sooner.
    for (const { key, text } of VARIANTS) {
      const sentences = (text.match(/[.?]+(?=\s|$)/g) ?? []).length;
      expect(sentences, `${key}: "${text}"`).toBeLessThanOrEqual(2);
    }
  });

  it('never mentions being a model, and never apologises for itself', () => {
    const banned = ['as an ai', 'language model', "i'm just", 'i am just', 'as a language'];
    for (const { key, text } of VARIANTS) {
      const lower = text.toLowerCase();
      for (const phrase of banned) expect(lower, `${key}: "${text}"`).not.toContain(phrase);
    }
  });

  it('contains no emoji', () => {
    // The lines are read aloud as often as they are shown. A pictograph is
    // either silence or a screen-reader announcement nobody asked for.
    for (const { key, text } of VARIANTS) {
      expect(/\p{Extended_Pictographic}/u.test(text), `${key}: "${text}"`).toBe(false);
    }
  });
});

describe('renderPhrase', () => {
  it('substitutes the params it is given', () => {
    expect(renderPhrase('booked', { referenceSpoken: 'W D A 6 Y' })).toBe('Booked. Your reference is W D A 6 Y.');
  });

  it('leaves no placeholder visible when a param is missing', () => {
    for (const key of KEYS) {
      for (let seed = 0; seed < PHRASES[key].length; seed += 1) {
        const rendered = renderPhrase(key, {}, seed);
        expect(rendered, `${key} variant ${seed}`).not.toContain('{');
        expect(rendered, `${key} variant ${seed}`).not.toContain('}');
      }
    }
  });

  it('tidies the whitespace and punctuation a missing param leaves behind', () => {
    // "Booked. Your reference is ." is worse than saying nothing about it.
    expect(renderPhrase('booked', {})).toBe('Booked. Your reference is.');
    expect(renderPhrase('readback', {})).toBe('at, under, ending. Shall I book that?');
    for (const key of KEYS) {
      const rendered = renderPhrase(key, {});
      expect(rendered, key).toBe(rendered.trim());
      expect(rendered, key).not.toMatch(/\s{2,}/);
      expect(rendered, key).not.toMatch(/\s[.,?]/);
    }
  });

  it('renders a real read-back the way the demo says it', () => {
    expect(
      renderPhrase('readback', {
        dateSpoken: 'Friday the 28th',
        timeSpoken: '7pm',
        guests: '4 guests',
        name: 'Karani',
        phoneTail: '1447',
      }),
    ).toBe('Friday the 28th at 7pm, 4 guests, under Karani, ending 1447. Shall I book that?');
  });

  it('coerces numeric params rather than dropping them', () => {
    expect(renderPhrase('ask_disambiguate', { options: '4 or 5', slot: 'partySize' })).toBe('4 or 5?');
  });
});

describe('variantFor', () => {
  it('is deterministic for a given seed', () => {
    for (const key of KEYS) {
      for (let seed = -20; seed <= 20; seed += 1) {
        expect(variantFor(key, seed)).toBe(variantFor(key, seed));
      }
    }
  });

  it('is always a variant that exists', () => {
    // Seeds are turn numbers, so they are unbounded and occasionally strange.
    const seeds = [-1000, -7, -1, 0, 1, 2, 3, 7, 41, 1000, Number.MAX_SAFE_INTEGER];
    for (const key of KEYS) {
      for (const seed of seeds) {
        const index = variantFor(key, seed);
        expect(Number.isInteger(index), `${key} @ ${seed}`).toBe(true);
        expect(index, `${key} @ ${seed}`).toBeGreaterThanOrEqual(0);
        expect(index, `${key} @ ${seed}`).toBeLessThan(PHRASES[key].length);
      }
    }
  });
});

describe('bakeablePhrases', () => {
  const baked = bakeablePhrases();

  it('meets the prebaked-cache size R-26 requires', () => {
    // R-26: at least twenty lines that can be synthesised at build time. This is
    // the mechanism the sub-second latency target rests on, not a nicety.
    expect(baked.length).toBeGreaterThanOrEqual(20);
  });

  it('returns only variants that carry no placeholders', () => {
    for (const phrase of baked) {
      expect(isBakeable(phrase.text), `${phrase.id}: "${phrase.text}"`).toBe(true);
      expect(phrase.text).not.toContain('{');
    }
  });

  it('leaves out every variant that does carry one', () => {
    const bakedIds = new Set(baked.map((p) => p.id));
    for (const { key, variant, text } of VARIANTS) {
      if (isBakeable(text)) continue;
      expect(bakedIds.has(`${key}.${variant}`), `${key}.${variant} is not bakeable`).toBe(false);
    }
  });

  it('gives every clip a unique id that points at its own text', () => {
    // The id is the filename in `public/audio/`, so a duplicate is one clip
    // silently overwriting another.
    const ids = baked.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const phrase of baked) {
      expect(phrase.id).toBe(`${phrase.key}.${phrase.variant}`);
      expect(PHRASES[phrase.key][phrase.variant]).toBe(phrase.text);
    }
  });

  it('covers the lines that carry the latency budget', () => {
    // The greeting and the fillers are the ones that must never wait on a
    // network round trip (plan §12.5, R-23).
    const ids = new Set(baked.map((p) => p.id));
    for (const id of ['greeting.0', 'filler_checking.0', 'filler_moment.0', 'still_there.0']) {
      expect(ids.has(id), `${id} is not prebaked`).toBe(true);
    }
  });
});
