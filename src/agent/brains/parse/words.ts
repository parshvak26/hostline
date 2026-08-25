/**
 * Spoken numbers → digits.
 *
 * Shared by the party, phone and time parsers, because speech recognition hands
 * back a mix of both forms in the same sentence and often in the same breath:
 * "table for four at half seven, oh nine eight two double one".
 *
 * Kept small and boring on purpose. It handles the range a restaurant booking
 * can contain — nothing above a hundred, no ordinals above thirty-first — and
 * returns null rather than improvising.
 */

export const UNITS: Readonly<Record<string, number>> = {
  zero: 0,
  oh: 0,
  o: 0,
  nought: 0,
  one: 1,
  won: 1,
  two: 2,
  to: 2,
  too: 2,
  three: 3,
  four: 4,
  for: 4,
  fore: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  ate: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

export const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

export const ORDINALS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
};

/** "twenty-first" style ordinals, handled as tens + unit-ordinal. */
const TENS_ORDINAL_SUFFIX = /^(twenty|thirty)[\s-]?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)$/;

/**
 * A single number word or numeral → its value.
 *
 * Returns null for anything else, including words like "a" that mean one only
 * in specific phrasings — resolving those is the calling parser's business,
 * since "a table" and "a quarter past" mean very different things.
 */
export function wordToNumber(token: string): number | null {
  const word = token.trim().toLowerCase().replace(/[.,]/g, '');
  if (word === '') return null;
  if (/^\d+$/.test(word)) return Number(word);

  const unit = UNITS[word];
  if (unit !== undefined) return unit;

  const ten = TENS[word];
  if (ten !== undefined) return ten;

  const ordinal = ORDINALS[word];
  if (ordinal !== undefined) return ordinal;

  const numericOrdinal = /^(\d+)(st|nd|rd|th)$/.exec(word);
  if (numericOrdinal?.[1] !== undefined) return Number(numericOrdinal[1]);

  const compound = TENS_ORDINAL_SUFFIX.exec(word);
  if (compound?.[1] !== undefined && compound[2] !== undefined) {
    const tens = TENS[compound[1]] ?? 0;
    const units = ORDINALS[compound[2]] ?? 0;
    return tens + units;
  }

  const hyphenated = /^(twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety)[\s-](\w+)$/.exec(word);
  if (hyphenated?.[1] !== undefined && hyphenated[2] !== undefined) {
    const tens = TENS[hyphenated[1]];
    const units = UNITS[hyphenated[2]];
    if (tens !== undefined && units !== undefined && units < 10) return tens + units;
  }

  return null;
}

/**
 * A short phrase → one number. "twenty five" → 25, "a hundred" → 100.
 *
 * Only used where the whole phrase is expected to be a number; parsers that
 * need to find a number inside a sentence scan token by token instead.
 */
export function phraseToNumber(phrase: string): number | null {
  const tokens = phrase
    .toLowerCase()
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter((t) => t !== '' && t !== 'and');
  if (tokens.length === 0) return null;

  const first = tokens[0];
  if (tokens.length === 1 && first !== undefined) return wordToNumber(first);

  if (tokens.length === 2 && first !== undefined) {
    const second = tokens[1];
    if (second !== undefined) {
      if (first === 'a' && second === 'hundred') return 100;
      const tens = TENS[first];
      const units = wordToNumber(second);
      if (tens !== undefined && units !== null && units < 10) return tens + units;
      const head = wordToNumber(first);
      if (head !== null && second === 'hundred') return head * 100;
    }
  }

  return null;
}

/**
 * Every digit in an utterance, in order, expanding number words and honouring
 * "double" and "triple". Used by the phone parser.
 *
 * "double one" is genuinely common in spoken Indian and British English phone
 * numbers and is the sort of thing that makes a demo feel like it was built by
 * someone who listened to real people.
 */
export function extractDigits(text: string): string {
  const tokens = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9+\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t !== '');

  const digits: string[] = [];
  let repeat = 1;

  for (const token of tokens) {
    if (token === 'double') {
      repeat = 2;
      continue;
    }
    if (token === 'triple' || token === 'treble') {
      repeat = 3;
      continue;
    }

    if (/^\d+$/.test(token)) {
      for (let i = 0; i < repeat; i += 1) digits.push(token);
      repeat = 1;
      continue;
    }

    const value = wordToNumber(token);
    if (value !== null && value >= 0 && value <= 9) {
      for (let i = 0; i < repeat; i += 1) digits.push(String(value));
      repeat = 1;
      continue;
    }

    // Teens and tens spoken inside a phone number ("nineteen" → "19").
    if (value !== null && value >= 10 && value <= 99) {
      for (let i = 0; i < repeat; i += 1) digits.push(String(value));
      repeat = 1;
      continue;
    }

    // Any other word breaks a "double"/"triple" that never landed.
    repeat = 1;
  }

  return digits.join('');
}
