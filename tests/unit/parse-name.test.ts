import { describe, expect, it } from 'vitest';

import { parseName } from '../../src/agent/brains/parse/name.js';
import type { ParseContext } from '../../src/agent/brains/parse/types.js';
import config from '../../src/config/restaurant.json';
import type { RestaurantConfig } from '../../src/engine/types.js';

const ctx: ParseContext = {
  today: '2026-08-25',
  nowTime: '18:00',
  config: config as RestaurantConfig,
};

/** Asserts a parse succeeded and returns the value, so `.value` is never read blind. */
function value(text: string): string {
  const result = parseName(text, ctx);
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error('unreachable');
  return result.value;
}

function expectNone(text: string): void {
  expect(parseName(text, ctx).kind).toBe('none');
}

describe('parseName — bare names', () => {
  it('takes a single word as given', () => {
    expect(value('Karani')).toBe('Karani');
  });

  it('takes two words as given', () => {
    expect(value('Priya Karani')).toBe('Priya Karani');
  });

  it('preserves hyphens and apostrophes', () => {
    expect(value("Anne-Marie O'Brien")).toBe("Anne-Marie O'Brien");
  });

  it('accepts accented Latin letters', () => {
    expect(value('María José')).toBe('María José');
  });

  it('keeps two initials as initials rather than joining them', () => {
    expect(value('J R Karani')).toBe('J R Karani');
  });

  it('reports the source text it matched', () => {
    const result = parseName('  the name is Karani  ', ctx);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.matched).toBe('the name is Karani');
  });
});

describe('parseName — capitalisation repair', () => {
  it('capitalises a lowercase single name', () => {
    expect(value('karani')).toBe('Karani');
  });

  it('capitalises every word', () => {
    expect(value('priya karani')).toBe('Priya Karani');
  });

  it('capitalises after an apostrophe', () => {
    expect(value("o'brien")).toBe("O'Brien");
  });

  it('capitalises after a hyphen', () => {
    expect(value('anne-marie')).toBe('Anne-Marie');
  });

  it('applies the McX heuristic', () => {
    expect(value('mcdonald')).toBe('McDonald');
    expect(value('mcgregor')).toBe('McGregor');
  });

  it('applies the McX heuristic even where it may be wrong (documented behaviour)', () => {
    // Someone whose name really is spelled "Mcintyre" gets it wrong. The
    // transcript carries no capitalisation, so the parser cannot know; the
    // confirmation step is where the visitor corrects it.
    expect(value('mcintyre')).toBe('McIntyre');
  });

  it('leaves Mac- alone', () => {
    expect(value('mackie')).toBe('Mackie');
  });

  it('flattens shouting', () => {
    expect(value('KARANI')).toBe('Karani');
  });

  it('collapses runs of whitespace', () => {
    expect(value('priya    karani')).toBe('Priya Karani');
  });
});

describe('parseName — filler stripping', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["it's under Karani", 'Karani'],
    ['its under Karani', 'Karani'],
    ["the name's Karani", 'Karani'],
    ['the name is Karani', 'Karani'],
    ['put it under Karani', 'Karani'],
    ['put me down under Karani', 'Karani'],
    ['book it for Karani', 'Karani'],
    ['booking is for Karani', 'Karani'],
    ['my name is Priya', 'Priya'],
    ['this is Priya', 'Priya'],
    ['Karani, please', 'Karani'],
    ['Karani, thanks', 'Karani'],
    ['just Karani', 'Karani'],
    ['surname Karani', 'Karani'],
    ['last name Karani', 'Karani'],
    ['under Karani', 'Karani'],
    ["I'm Priya Karani", 'Priya Karani'],
    ['hi, the name is Priya Karani please', 'Priya Karani'],
  ];

  for (const [input, expected] of cases) {
    it(`strips filler from "${input}"`, () => {
      expect(value(input)).toBe(expected);
    });
  }

  it('does not eat the start of a name that begins with a filler word', () => {
    expect(value('Justin')).toBe('Justin');
    expect(value('Yesenia')).toBe('Yesenia');
  });
});

describe('parseName — spell-out repair', () => {
  it('collapses a hyphenated spell-out', () => {
    expect(value('K-A-R-A-N-I')).toBe('Karani');
  });

  it('collapses a spaced spell-out', () => {
    expect(value('K A R A N I')).toBe('Karani');
  });

  it('collapses a period-separated spell-out', () => {
    expect(value('K. A. R. A. N. I.')).toBe('Karani');
  });

  it('collapses a spell-out with no spaces at all', () => {
    expect(value('K.A.R.A.N.I.')).toBe('Karani');
  });

  it('treats a spell-out after the same word as a repetition, not a second name', () => {
    expect(value("Karani, that's K-A-R-A-N-I")).toBe('Karani');
  });

  it('lets a spell-out correct the word it follows', () => {
    expect(value("Karan, that's K-A-R-A-N-I")).toBe('Karani');
  });

  it('treats an unrelated spell-out as an extra word, not a correction', () => {
    expect(value("Priya, that's K-A-R-A-N-I")).toBe('Priya Karani');
  });

  it('accepts a spell-out beside a spoken first name', () => {
    expect(value('Priya K-A-R-A-N-I')).toBe('Priya Karani');
  });

  it('accepts "spelled" as the marker', () => {
    expect(value('Karani spelled K A R A N I')).toBe('Karani');
  });

  it('ignores a tail that is not a spelling', () => {
    expect(value("Karani, that's right")).toBe('Karani');
  });
});

describe('parseName — non-names', () => {
  const stopWords = [
    'yes',
    'no',
    'yeah',
    'ok',
    'okay',
    'sure',
    'thanks',
    'thank you',
    'hello',
    'hi',
    'please',
    'maybe',
    'dunno',
    'nothing',
    'whatever',
  ];

  for (const word of stopWords) {
    it(`rejects "${word}"`, () => {
      expectNone(word);
      expectNone(word.toUpperCase());
    });
  }

  it('rejects a single letter', () => {
    expectNone('K');
    expectNone('k.');
  });

  it('rejects empty and whitespace-only input', () => {
    expectNone('');
    expectNone('   ');
  });

  it('rejects a sentence that is plainly an answer to a different question', () => {
    expectNone('I would like to book a table for four people');
  });
});

describe('parseName — digits', () => {
  it('rejects an all-digit string', () => {
    expectNone('12345');
  });

  it('rejects a phone number in the name slot', () => {
    expectNone('07700 900123');
  });

  it('rejects a name with a four-digit run stuck to it', () => {
    expectNone('Karani 1234');
  });

  it('rejects stray single digits too, via the character restriction', () => {
    expectNone('Karani 4');
  });
});

describe('parseName — character restriction (plan §13)', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<b>Karani</b>',
    '${process.env.SECRET}',
    '`rm -rf /`',
    'Karani<>',
    'Karani & Sons',
    'karani@example.com',
    'Karani\\Priya',
    '{{name}}',
  ];

  for (const input of hostile) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expectNone(input);
    });
  }
});

describe('parseName — length', () => {
  it('accepts a name of exactly sixty characters', () => {
    expect(value('a'.repeat(60))).toBe(`A${'a'.repeat(59)}`);
  });

  it('refuses a name of sixty-one characters rather than truncating it', () => {
    expectNone('a'.repeat(61));
  });

  it('refuses a 5,000-character input, and does so promptly', () => {
    const started = Date.now();
    expectNone('a'.repeat(5000));
    expectNone('Ka'.repeat(2500));
    expectNone(`<script>${'a'.repeat(5000)}</script>`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not backtrack on a long spell-out-shaped string', () => {
    // Sits just under the input cap, so the spelling regexes actually run on it.
    const started = Date.now();
    expectNone(`${'a-'.repeat(149)}a`);
    expectNone('a.'.repeat(149));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('parseName — ambiguity', () => {
  it('refuses to choose between two names joined by "or"', () => {
    const result = parseName('Karani or Sharma', ctx);
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates).toEqual(['Karani', 'Sharma']);
  });

  it('refuses to choose between two names joined by "and"', () => {
    const result = parseName('Priya and Anjali', ctx);
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.candidates).toEqual(['Priya', 'Anjali']);
  });

  it('is not confused by a coordinator with only one name beside it', () => {
    expect(value('and Karani')).toBe('Karani');
  });
});

describe('parseName — purity', () => {
  it('returns an equal result for an equal input', () => {
    expect(parseName("it's under K-A-R-A-N-I", ctx)).toEqual(parseName("it's under K-A-R-A-N-I", ctx));
  });

  it('does not depend on the context it is handed', () => {
    const other: ParseContext = { ...ctx, today: '2027-01-01', nowTime: '09:00', date: '2027-01-02' };
    expect(parseName('Priya Karani', other)).toEqual(parseName('Priya Karani', ctx));
  });
});
