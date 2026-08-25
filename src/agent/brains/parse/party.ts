/**
 * Party size, from however a person happens to say it.
 *
 * "four", "just me", "a table for two", "party of six", "four or five of us"
 * are all the same slot and none of them is a number. This file turns speech
 * into a candidate count and stops there.
 *
 * It deliberately does not enforce `minPartySize`/`maxPartySize`. "Party of
 * forty" parses to 40 and "party of zero" parses to 0, because understanding
 * what someone said and deciding whether it is allowed are different jobs and
 * the second one belongs to `src/engine/validate.ts` (plan §7.2) — the layer
 * the adversarial tests aim at. A parser that quietly clamped 40 to 8 would
 * seat nine people at a table for eight and no test one layer up could see it
 * happen; a parser that returned "unparseable" for 40 would lose the fact that
 * the visitor gave a perfectly clear answer, and with it the escalation path
 * §4.3 promises for large groups.
 *
 * Negative numbers get the same treatment. Nobody says "minus three", but a
 * hostile brain will happily propose it, so `-3` parses as -3 and is refused
 * upstairs with a typed reason rather than disappearing here.
 */

import type { ParseContext, ParseResult } from './types.js';
import { ambiguous, normalise, notFound, parsed } from './types.js';
import { phraseToNumber } from './words.js';

/* --------------------------------------------------------------- numbers -- */

const UNIT_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEEN_WORDS = [
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS_WORDS = ['twenty', 'thirty', 'forty', 'fourty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/**
 * Number words as they occur inside a sentence.
 *
 * Narrower than `words.ts` on purpose. That table carries the recogniser's
 * homophones — "for"/"fore" → 4, "to"/"too" → 2, "ate" → 8, "oh" → 0 — which
 * are the right call for a phone number and the wrong one here: "a table for
 * six" would read as both four and six and come back ambiguous.
 */
const NUM = `(?:\\d{1,3}|(?:${TENS_WORDS.join('|')})(?:[ -](?:${UNIT_WORDS.join('|')}))?|${TEEN_WORDS.join(
  '|',
)}|${UNIT_WORDS.join('|')}|zero)`;

const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';

const ORDINAL_WORDS =
  '(?:twenty|thirty)[ -]?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|' +
  'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|' +
  'fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth';

const RELATIVES =
  'wife|husband|partner|girlfriend|boyfriend|missus|other half|mum|mother|dad|father|' +
  'son|daughter|friend|colleague|sister|brother';

/* ------------------------------------------------------- what is not a party -
 *
 * Reading "six" is easy. Knowing that the six in "at six", "the 6th", "6:30",
 * "six weeks" and "98765 43210" is not a party size is the whole difficulty,
 * and there is no way to do it without a heuristic. So the heuristic lives in
 * one list instead of being scattered through the patterns below: every span
 * matched here is blanked out (same length, so offsets survive) before anything
 * looks for a count.
 *
 * Its limits, honestly:
 *   - "around six" is six people here and six o'clock in the time parser. Both
 *     readings are real; this file always answers with people, which is only
 *     safe because the caller consults it about the party slot specifically. A
 *     parser run blindly over every utterance would need the pending question
 *     as context, and does not get it.
 *   - "a table for four thirty" masks as a time and yields nothing. That is a
 *     genuine ambiguity in English, and returning nothing makes the agent ask
 *     rather than guess.
 *   - A bare "seven" is seven people. Same caveat as "around six".
 *   - "me and my wife and my son" is read as two. Chained relatives would need
 *     a grammar, and getting it wrong upward is worse than asking again.
 *   - Only the ordinals and month names in `words.ts`' range are covered, so an
 *     exotic date phrasing can still leak a number through. The validator's
 *     range check is the backstop, not this list.
 */
const EXCLUSIONS: readonly RegExp[] = [
  // Phone numbers: anything hanging off a leading +, then any run of five or
  // more digits. The + rule goes first because masking the runs would otherwise
  // strip a "+91" back to a bare 91.
  /\+\s?\d[\d -]*\d/g,
  /\b\d{5,}\b/g,
  // Years, and times said as bare digits ("nineteen thirty" → "1930").
  /\b\d{4}\b/g,
  // 7:30, 7.30
  /\b\d{1,2}\s*[:.]\s*\d{2}\b/g,
  new RegExp(`\\b${NUM}\\s*(?:a|p)\\.?\\s?m\\.?\\b`, 'g'),
  new RegExp(`\\b${NUM}\\s*o'?\\s?clock\\b`, 'g'),
  new RegExp(`\\b(?:half|quarter)\\s+(?:past|to|after)?\\s*${NUM}\\b`, 'g'),
  new RegExp(`\\b${NUM}\\s+(?:thirty|fifteen|forty[ -]?five|o'?\\s?clock)\\b`, 'g'),
  // Prepositions that place a number on the clock rather than at the table.
  // "about" and "around" are excluded from this list: they hedge a count just
  // as often as a time ("about six of us"), and §4.3 wants the count.
  new RegExp(`\\b(?:at|by|after|before|until|till|til|from|past)\\s+(?:about\\s+|around\\s+)?${NUM}\\b`, 'g'),
  new RegExp(
    `\\b${NUM}\\s+(?:hours?|hrs?|minutes?|mins?|seconds?|days?|weeks?|months?|years?|nights?)\\b`,
    'g',
  ),
  // Dates: "the 28th", "the twenty-eighth", "28 august", "august 28".
  /\b\d{1,2}\s*(?:st|nd|rd|th)\b/g,
  new RegExp(`\\b(?:${ORDINAL_WORDS})\\b`, 'g'),
  new RegExp(`\\b\\d{1,2}\\s+(?:of\\s+)?(?:${MONTHS})\\b`, 'g'),
  new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}\\b`, 'g'),
];

/* -------------------------------------------------------------- patterns -- */

interface Cue {
  readonly re: RegExp;
  /**
   * True when the phrasing names a *kind* of person. That is what makes "four
   * adults and two kids" a party of six: two counts joined by "and", each of
   * them counting people, add up. Counts without a noun do not — "for four and
   * five" is someone changing their mind, not nine covers.
   */
  readonly additive: boolean;
}

/** Phrasings that name a count outright. The capture group holds the number. */
const CUED: readonly Cue[] = [
  {
    re: new RegExp(`\\b(?:table|booking|reservation|seats?|room|space)\\s+for\\s+(${NUM})\\b`, 'g'),
    additive: false,
  },
  {
    re: new RegExp(`\\b(?:party|group|table|booking|reservation)\\s+of\\s+(${NUM})\\b`, 'g'),
    additive: false,
  },
  { re: new RegExp(`\\bfor\\s+(${NUM})\\b`, 'g'), additive: false },
  {
    re: new RegExp(
      `\\b(${NUM})\\s+(?:people|persons?|guests?|adults?|grown[ -]?ups?|kids?|children|child|diners?|covers?|pax|heads|of\\s+us|in\\s+(?:our|the)\\s+(?:party|group))\\b`,
      'g',
    ),
    additive: true,
  },
  {
    re: new RegExp(
      `\\b(?:we\\s+(?:are|will\\s+be)|we're|we\\s+were|there\\s+(?:are|is)|there's|it\\s+is|it's|make\\s+it|just|only)\\s+(${NUM})\\b`,
      'g',
    ),
    additive: false,
  },
];

/** Phrasings that mean a count without containing a number. */
const FIXED: ReadonlyArray<readonly [RegExp, number]> = [
  [/\bhalf\s+a\s+dozen\b/g, 6],
  [/\b(?:a|one)\s+dozen\b|\bdozen\b/g, 12],
  [/\bjust\s+me\b|\bonly\s+me\b|\bme\s+alone\b|\bby\s+myself\b|\bon\s+my\s+own\b|\bmyself\b|\bsolo\b|\bjust\s+the\s+one\b/g, 1],
  [new RegExp(`\\b(?:me|myself|i)\\s+and\\s+(?:my|the)\\s+(?:${RELATIVES})\\b`, 'g'), 2],
  [new RegExp(`\\b(?:my|the)\\s+(?:${RELATIVES})\\s+and\\s+(?:me|i|myself)\\b`, 'g'), 2],
  // "a couple of hours" is not two people.
  [/\b(?:a\s+)?couple(?:\s+of\s+us)?\b(?!\s+of\s+(?:hours?|days?|weeks?|minutes?|mins?|months?|years?))/g, 2],
];

/** Anything left that looks like a number: "four", "4", "six-ish". */
const BARE = new RegExp(`\\b(${NUM})\\b`, 'g');

/** "-3" or "minus three", which only a machine ever proposes. */
const NEGATIVE = new RegExp(`(?:^|[^\\w])(?:minus\\s+|-\\s?)(${NUM})\\b`);

/** The gap between two counts that are parts of one party, not rival readings. */
const SUM_GAP = /^(?:and|plus|and also|and then)$/;

/**
 * The gap between two counts, when the visitor is offering a choice.
 *
 * This is the R-03 case: "four or five" is not a party size, it is a question,
 * and answering it with either number would make the agent confidently wrong.
 */
const RANGE_GAP = /^(?:-|or|to|or maybe|maybe|or it could be|or so|or possibly)$/;

/**
 * The gap between two counts, when the second replaces the first.
 *
 * The distinction from `RANGE_GAP` is the entire point: "four or five" leaves
 * two live readings and must be asked about, while "four, actually make it
 * five" leaves one — the visitor already did the choosing. Checked first, so a
 * correction that happens to contain "or" still counts as a correction.
 */
const REPLACEMENT = /\b(?:actually|make it|sorry|scratch that|no wait|i meant|instead|rather|change that)\b/;

/* ---------------------------------------------------------------- engine -- */

interface Mention {
  readonly value: number;
  readonly start: number;
  readonly end: number;
  readonly additive: boolean;
}

function toNumber(token: string): number | null {
  const cleaned = token.trim().replace(/-/g, ' ');
  if (/^\d{1,3}$/.test(cleaned)) return Number(cleaned);
  return phraseToNumber(cleaned);
}

/** Blanks out every excluded span, preserving length so offsets stay usable. */
function maskExclusions(text: string): string {
  let out = text;
  for (const re of EXCLUSIONS) {
    out = out.replace(re, (span) => '#'.repeat(span.length));
  }
  return out;
}

function collect(masked: string): Mention[] {
  const found: Mention[] = [];

  for (const cue of CUED) {
    for (const match of masked.matchAll(cue.re)) {
      const captured = match[1];
      if (captured === undefined || match.index === undefined) continue;
      const value = toNumber(captured);
      if (value === null) continue;
      found.push({ value, start: match.index, end: match.index + match[0].length, additive: cue.additive });
    }
  }

  for (const [re, value] of FIXED) {
    for (const match of masked.matchAll(re)) {
      if (match.index === undefined) continue;
      found.push({ value, start: match.index, end: match.index + match[0].length, additive: false });
    }
  }

  for (const match of masked.matchAll(BARE)) {
    const captured = match[1];
    if (captured === undefined || match.index === undefined) continue;
    const value = toNumber(captured);
    if (value === null) continue;
    found.push({ value, start: match.index, end: match.index + match[0].length, additive: false });
  }

  return found;
}

/**
 * Longest match wins where two overlap.
 *
 * That ordering is load-bearing, not tidiness: "half a dozen" also contains a
 * dozen, "just me and my wife" also contains "just me", and taking whichever
 * started first would answer 12 and 1. Longest-first answers 6 and 2.
 */
function longestNonOverlapping(mentions: readonly Mention[]): Mention[] {
  const ordered = [...mentions].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: Mention[] = [];
  for (const mention of ordered) {
    const clashes = kept.some((k) => mention.start < k.end && k.start < mention.end);
    if (!clashes) kept.push(mention);
  }
  return kept.sort((a, b) => a.start - b.start);
}

function gapBetween(masked: string, before: Mention, after: Mention): string {
  return masked.slice(before.end, after.start).trim().replace(/\s+/g, ' ');
}

/** "four adults and two kids" is one party of six, said in two halves. */
function foldSums(masked: string, mentions: readonly Mention[]): Mention[] {
  const folded: Mention[] = [];
  for (const mention of mentions) {
    const previous = folded[folded.length - 1];
    if (previous !== undefined && previous.additive && SUM_GAP.test(gapBetween(masked, previous, mention))) {
      folded[folded.length - 1] = {
        value: previous.value + mention.value,
        start: previous.start,
        end: mention.end,
        additive: true,
      };
      continue;
    }
    folded.push(mention);
  }
  return folded;
}

function isRange(gap: string): boolean {
  if (REPLACEMENT.test(gap)) return false;
  return RANGE_GAP.test(gap);
}

/**
 * The context is accepted for a uniform parser signature and then ignored: a
 * party size means the same thing on any date, at any hour, in any restaurant.
 * In particular it is *not* consulted for `service.minPartySize` or
 * `maxPartySize` — see the note at the top of this file.
 */
export function parseParty(text: string, _ctx: ParseContext): ParseResult<number> {
  const raw = normalise(text);
  if (raw === '') return notFound();

  // Checked before anything else: a minus sign is never part of a larger
  // phrasing, and passing it straight through is what lets the validator
  // reject it by name instead of the agent re-asking as if it misheard.
  const negative = NEGATIVE.exec(raw);
  if (negative?.[1] !== undefined) {
    const value = toNumber(negative[1]);
    if (value !== null) return parsed(-value, negative[0].trim());
  }

  const masked = maskExclusions(raw);
  const mentions = foldSums(masked, longestNonOverlapping(collect(masked)));
  if (mentions.length === 0) return notFound();

  // Group consecutive mentions into runs joined by a range connective. A run
  // of one is a plain answer; a run of two or more is a choice the visitor has
  // not made yet. Later runs supersede earlier ones, so a correction — which
  // by definition breaks the run — leaves the last value standing.
  const runs: Mention[][] = [];
  for (const mention of mentions) {
    const current = runs[runs.length - 1];
    const previous = current?.[current.length - 1];
    if (
      current !== undefined &&
      previous !== undefined &&
      previous.value !== mention.value &&
      isRange(gapBetween(masked, previous, mention))
    ) {
      current.push(mention);
    } else {
      runs.push([mention]);
    }
  }

  const last = runs[runs.length - 1];
  if (last === undefined || last.length === 0) return notFound();

  const first = last[0];
  if (last.length === 1 && first !== undefined) {
    return parsed(first.value, raw.slice(first.start, first.end));
  }

  const candidates = last.map((m) => m.value);
  return ambiguous(candidates, `heard a range (${candidates.join(' or ')}); ask which it is`);
}
