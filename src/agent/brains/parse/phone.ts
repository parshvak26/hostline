/**
 * Phone numbers, spoken and typed.
 *
 * This file decides which digits the visitor said. It does not decide whether
 * those digits are a number worth storing — `validatePhone` in
 * `src/engine/validate.ts` owns the 7–15 rule from plan §10.2 and rejects with
 * `phone_too_short` / `phone_too_long`, which the agent can turn into a useful
 * sentence ("that's only four digits — what's the rest?"). So a four-digit run
 * and a forty-digit run both parse here, faithfully, and are both refused one
 * layer up. The parser guessing at length would replace a typed, explainable
 * refusal with a silent shrug, and the adversarial tests aim at the layer that
 * says no.
 *
 * The other half of the same idea: this parser never invents a country code.
 * A bare ten-digit number is stored as ten digits, not helpfully promoted to
 * `91…` because the restaurant happens to be in Bandra. Guessing would produce
 * a number that looks right on the confirmation screen and rings nobody.
 */

import type { ParseContext, ParseResult } from './types.js';
import { notFound, parsed } from './types.js';
import { extractDigits, wordToNumber } from './words.js';

/**
 * Below this, a digit run is a party size, a table number, or the tail of a
 * date — not a phone number. Four rather than seven because §4.1's repair for a
 * mis-heard number asks only for the last four digits, and that answer has to
 * parse. The cost of the choice is stated at {@link isPlausibleRun}.
 */
const MIN_RUN_DIGITS = 4;

/**
 * Only used to decide whether removing a trunk prefix leaves something that is
 * still a phone number. It is not a validity test — that lives in the engine.
 */
const PLAUSIBLE_MIN_DIGITS = 7;

/** Words that carry a run forward without being a digit themselves. */
const RUN_CONNECTORS: ReadonlySet<string> = new Set(['double', 'triple', 'treble']);

/**
 * `words.ts` is generously homophonic — "to" is 2, "for" is 4, "ate" is 8 —
 * which is right in the middle of a dictated number and wrong at the front of
 * one. "send it to 98200 11234" is a preposition and a number, never 2 followed
 * by ten digits. So these spellings are dropped when they open a run that
 * continues with actual numerals. Spoken-word runs ("for four seven one") are
 * left alone, because there the word really might be a digit.
 */
const AMBIGUOUS_PREFIX: ReadonlySet<string> = new Set(['to', 'too', 'for', 'fore', 'won', 'ate']);

/**
 * Digits that belong to some other slot. Blanked before scanning so they cannot
 * form or extend a run: "19:30" is four digits and "28/08/2026" is eight.
 * Bounded quantifiers throughout — this parser is handed hostile input by
 * design, and a backtracking regex is a denial of service with extra steps.
 */
const OTHER_SLOT_DIGITS: readonly RegExp[] = [
  /\b\d{1,2}\s?[:.]\s?\d{2}\b/g, // 7:30, 19.30
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g, // 2026-08-25
  /\b\d{1,2}\s?\/\s?\d{1,2}(?:\s?\/\s?\d{2,4})?\b/g, // 28/8, 28/08/2026
  /\b\d{1,2}(?:st|nd|rd|th)\b/g, // the 28th
  /\b\d{1,2}\s?[ap]\.?m\.?/g, // 7pm, 7 p.m.
];

/**
 * The wrapping a dictated number arrives in. Stripping it is mostly cosmetic —
 * the run scanner ignores non-digit words anyway — but it keeps `matched` to
 * the number itself, which is what the transcript and any later repair prompt
 * want to show.
 */
const FILLERS: readonly RegExp[] = [
  /\b(?:you\s+can\s+)?(?:reach|call|text|ring|contact|get)\s+(?:me|us|him|her)\s+(?:on|at)\b/g,
  /\b(?:my|the|his|her)\s+(?:mobile|cell|phone|contact)?\s*(?:number|no)'?s?\b/g,
  /\bmy\s+(?:mobile|cell|phone)'?s?\b/g,
  /\bnumber\s+is\b/g,
  /\b(?:it|that)'?s\b/g,
];

/* ------------------------------------------------------------- parsing -- */

interface Run {
  /** The tokens that produced the digits, for `matched`. */
  readonly text: string;
  readonly digits: string;
}

/**
 * @param _ctx unused. The signature is the shared parser contract: a phone
 * number means the same thing on every date, in every locale this restaurant
 * serves, so nothing in {@link ParseContext} can change the answer.
 */
export function parsePhone(text: string, _ctx: ParseContext): ParseResult<string> {
  const cleaned = clean(text);
  if (cleaned === '') return notFound();

  const runs = digitRuns(cleaned.split(' '));
  const best = longest(runs);
  if (best === null || !isPlausibleRun(best.digits)) return notFound();

  return parsed(normalisePhone(best.digits), best.text);
}

/**
 * Lowercase, remove the digits that belong to other slots, drop the filler, and
 * flatten every separator a number can be written with — `+`, `-`, `.`, `()`,
 * non-breaking spaces — to a plain space. `words.ts` tokenises on whitespace
 * and would drop "+91" and "982-001-1234" whole, so the flattening has to
 * happen before it sees them.
 *
 * The `+` is thrown away rather than recorded. It marks a country code as
 * international, and we neither add nor remove one, so it carries nothing.
 */
function clean(text: string): string {
  let out = text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[‐-―]/g, '-');

  for (const pattern of OTHER_SLOT_DIGITS) out = out.replace(pattern, ' ');
  for (const filler of FILLERS) out = out.replace(filler, ' ');

  return out.replace(/[^a-z0-9']+/g, ' ').trim();
}

/**
 * Every maximal stretch of digit-bearing tokens, each reduced to its digits.
 *
 * Scanning for runs rather than sweeping the whole utterance for digits is what
 * keeps "table for 4 at 8, my number is 98200 11234" from becoming
 * `4898200 11234`. Any word that is not a digit ends the run.
 */
function digitRuns(tokens: readonly string[]): readonly Run[] {
  const runs: Run[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const text = trimAmbiguousPrefix(current).join(' ');
    runs.push({ text, digits: extractDigits(text) });
    current = [];
  };

  for (const token of tokens) {
    if (token === '') continue;
    if (isDigitToken(token) || RUN_CONNECTORS.has(token)) {
      current.push(token);
      continue;
    }
    flush();
  }
  flush();

  return runs;
}

function isDigitToken(token: string): boolean {
  if (/^\d+$/.test(token)) return true;
  const value = wordToNumber(token);
  return value !== null && value >= 0 && value <= 99;
}

function trimAmbiguousPrefix(tokens: readonly string[]): readonly string[] {
  const first = tokens[0];
  const second = tokens[1];
  if (first === undefined || second === undefined) return tokens;
  if (AMBIGUOUS_PREFIX.has(first) && /^\d/.test(second)) return tokens.slice(1);
  return tokens;
}

function longest(runs: readonly Run[]): Run | null {
  let best: Run | null = null;
  for (const run of runs) {
    if (best === null || run.digits.length > best.digits.length) best = run;
  }
  return best;
}

/**
 * The one exclusion, and its cost, stated plainly.
 *
 * Anything shorter than {@link MIN_RUN_DIGITS} is a party size, a floor number,
 * or half a time. What this does *not* exclude is a bare year — "the 28th of
 * August 2026" leaves `2026`, which parses as a phone number. That is the
 * deliberate side of the trade: excluding four-digit runs would break the
 * §4.1 repair where the visitor is asked for the last four digits only, and
 * that repair matters more than a year leaking into a slot the validator will
 * reject as too short anyway.
 */
function isPlausibleRun(digits: string): boolean {
  return digits.length >= MIN_RUN_DIGITS;
}

/**
 * E.164-ish: digits only, no `+`, country code kept only if the visitor said
 * one.
 *
 * A leading zero is a trunk or IDD prefix in both supported locales (en-IN,
 * en-US) and belongs to neither number, so "091 98200 11234" and
 * "0 98200 11234" normalise to `919820011234` and `9820011234`. The stripping
 * is skipped when what is left is too short to be a phone number at all, so a
 * mis-heard `0000` reaches the validator intact rather than as `0`.
 */
function normalisePhone(digits: string): string {
  const withoutTrunk = digits.replace(/^0+/, '');
  return withoutTrunk.length >= PLAUSIBLE_MIN_DIGITS ? withoutTrunk : digits;
}

/* ---------------------------------------------------------- formatting -- */

interface Grouped {
  /** Country code without the `+`, when the number carries one. */
  readonly cc: string | null;
  readonly groups: readonly string[];
}

function onlyDigits(value: string): string {
  return value.replace(/\D+/g, '');
}

/**
 * Grouping, shared by the screen and the voice so they never disagree about
 * where a number breaks.
 *
 * The ten-digit case is genuinely ambiguous: `9820011234` is an Indian mobile
 * and `4155550142` is a US line, and both locales are supported. Indian mobile
 * numbers start 6–9 and NANP area codes start 2–9, so the split below is right
 * for everything except a US number in a 6–9 area code, which will be shown as
 * `91755 50142`. Wrong grouping is cosmetic; a wrong digit would not be.
 */
function group(value: string): Grouped {
  const d = onlyDigits(value);
  if (d.length === 0) return { cc: null, groups: [] };
  if (d.length === 12 && d.startsWith('91')) return { cc: '91', groups: fiveFive(d.slice(2)) };
  if (d.length === 11 && d.startsWith('1')) return { cc: '1', groups: nanp(d.slice(1)) };
  if (d.length === 10) return { cc: null, groups: /^[6-9]/.test(d) ? fiveFive(d) : nanp(d) };
  return { cc: null, groups: fallbackGroups(d) };
}

const fiveFive = (d: string): readonly string[] => [d.slice(0, 5), d.slice(5)];

const nanp = (d: string): readonly string[] => [d.slice(0, 3), d.slice(3, 6), d.slice(6)];

/**
 * Anything else — a mis-heard number on its way to being rejected — still has
 * to be readable while the agent asks about it, so it is broken into 3s and 4s.
 * Index arithmetic rather than repeated `slice` on the remainder, because the
 * input can be forty digits or forty thousand.
 */
function fallbackGroups(d: string): readonly string[] {
  const out: string[] = [];
  let i = 0;
  while (i < d.length) {
    const rest = d.length - i;
    const size = rest <= 4 ? rest : rest % 4 === 1 || rest % 4 === 2 ? 3 : 4;
    out.push(d.slice(i, i + size));
    i += size;
  }
  return out;
}

/** For the screen. Never throws; anything it cannot place, it groups. */
export function formatPhone(digits: string): string {
  const { cc, groups } = group(digits);
  if (groups.length === 0) return '';
  const body = groups.join(' ');
  return cc === null ? body : `+${cc} ${body}`;
}

/**
 * For the synthesiser.
 *
 * Handed `9820011234`, every engine in the TTS chain reads "nine billion, eight
 * hundred and twenty million…". Spaces between digits are what make it read
 * them one at a time, and the commas between groups produce the short pause a
 * person leaves when dictating — without them a fifteen-digit number arrives as
 * an unbroken sixteen-second monotone that nobody can write down. This is done
 * in plain text rather than SSML on purpose: the fallback voices in the
 * degradation chain do not all support `<say-as>`, and a read-back that only
 * works on the primary voice is a read-back that fails on the day it matters.
 */
export function spokenPhone(digits: string): string {
  const { cc, groups } = group(digits);
  if (groups.length === 0) return '';
  const spoken = groups.filter((g) => g !== '').map(spread);
  return cc === null ? spoken.join(', ') : [`plus ${spread(cc)}`, ...spoken].join(', ');
}

const spread = (chunk: string): string => chunk.split('').join(' ');

/**
 * The read-back tail (§4.1). The visitor already knows their own number, so the
 * confirmation says "ending 4471" rather than spending a second of speech
 * reciting all ten digits back at them. Returns fewer than four for a shorter
 * number, and never throws.
 */
export function lastFour(digits: string): string {
  return onlyDigits(digits).slice(-4);
}
