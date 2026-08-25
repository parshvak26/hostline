/**
 * Times out of speech.
 *
 * The hard part is not "7pm". It is a bare "seven", which carries no am/pm at
 * all, and the only honest tiebreaker a parser has is when the restaurant is
 * actually open: a dinner-only Tuesday makes "seven" mean 19:00 and nothing
 * else. So bare hours are resolved against that day's service windows — one
 * reading inside a window wins, two readings inside two windows is a question
 * rather than a guess, and a reading inside nothing is still returned so the
 * validator can answer with the real hours instead of the agent claiming it
 * misheard.
 *
 * The windows are used for disambiguation only. Opening hours, slot boundaries
 * and last seating are policy, and policy lives in `src/engine/validate.ts`
 * (plan §7.2). This file will happily hand back 03:00 if that is what was said.
 *
 * Two things deliberately do *not* produce a time:
 *
 *   - "in the evening", "for dinner", "for lunch" name a service, not a time.
 *     Turning "for dinner" into 19:00 would put a time in the slot that the
 *     visitor never gave, which is the exact failure this project is built to
 *     avoid. They return `none`, and the agent asks.
 *   - "early", "late". Same reason, less temptation.
 */

import type { ClockTime, OpeningDay } from '../../../engine/types.js';
import { minutesOf, spokenTime, timeFromMinutes, weekdayOf } from '../../../engine/time.js';
import type { ParseContext, ParseResult } from './types.js';
import { ambiguous, normalise, notFound, parsed } from './types.js';

/**
 * Hour words, curated rather than taken from `words.ts`.
 *
 * `UNITS` there maps the speech-recognition homophones `for`→4, `to`→2,
 * `ate`→8, `o`→0, which is right for a phone number and catastrophic here:
 * "table for four" would yield an hour and "quarter to eight" would lose its
 * preposition. Above twelve people say digits, so twelve is the ceiling.
 */
const HOUR_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * Hours 13–23 spoken as words: "nineteen thirty", "eighteen hundred".
 *
 * Kept separate from HOUR_WORDS and matched **only in a compound** — a teen
 * must be followed by minutes or by "hundred" — because several of these words
 * are also minute counts ("fifteen", "twenty") and most of them are plausible
 * party sizes. Requiring the compound removes both collisions: nobody says
 * "table for nineteen thirty".
 *
 * This exists because `ask_time_again` tells the visitor to "say it like half
 * seven, or nineteen thirty", and an agent that rejects the example it just
 * gave is worse than one that never gave it.
 */
const HOUR24_WORDS: Readonly<Record<string, number>> = {
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  'twenty one': 21,
  'twenty two': 22,
  'twenty three': 23,
};

/** Minute expressions said as one word. Five-minute granularity, as people do. */
const MINUTE_WORDS: Readonly<Record<string, number>> = {
  five: 5,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
};

/** The leading half of "twenty five", "forty five". */
const TENS_MINUTES: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
};

/**
 * Parts of the day that settle am/pm outright.
 *
 * "seven in the morning" is not a bare seven — the visitor said which one, and
 * honouring that matters more than what the windows imply. Meal names are
 * absent on purpose: "dinner" is a service, and the service windows already
 * encode where dinner is.
 */
const DAYPARTS: Readonly<Record<string, Meridiem>> = {
  morning: 'am',
  afternoon: 'pm',
  evening: 'pm',
  evenings: 'pm',
  night: 'pm',
  tonight: 'pm',
};

type Meridiem = 'am' | 'pm';

const MERIDIEM_TOKEN = /^([ap])\.?m$/;
const OCLOCK = /^o'?clock$/;
const DIGITS_ONLY = /^\d+$/;
const HOUR_DIGITS = /^\d{1,2}$/;
const HH_MM_TOKEN = /^(\d{1,2})[:.](\d{2})(am|pm|a\.m|p\.m)?$/;
const HOUR_MERIDIEM_TOKEN = /^(\d{1,2})(am|pm|a\.m|p\.m)$/;
const ISH_TOKEN = /^(\d{1,2})ish$/;
const COMPACT_TOKEN = /^(\d{3,4})$/;
/** A digit run long enough to be a phone fragment rather than a clock. */
const PHONE_RUN = /^\+?\d{3,}$/;

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface Reading {
  /** 0–23. Literal, before any am/pm resolution. */
  readonly hour: number;
  readonly minute: number;
  /** True when am/pm, a 24-hour form or a named time fixed the reading. */
  readonly explicit: boolean;
  /** How many tokens the match consumed. */
  readonly span: number;
  /** A number with nothing marking it as a time — subject to the party guard. */
  readonly bare: boolean;
}

interface Fragment {
  readonly value: number;
  readonly span: number;
}

/* ------------------------------------------------------------- tokenising -- */

/**
 * Splits on whitespace and hyphens, so "half-seven" reads as two tokens while
 * "7:30pm" and "o'clock" stay whole. Trailing full stops are shed because a
 * sentence-final "at 8." is still eight; nothing that means a time ends in one.
 */
function tokenise(normalised: string): readonly Token[] {
  const out: Token[] = [];
  const scanner = /[^\s-]+/g;
  let match: RegExpExecArray | null = scanner.exec(normalised);
  while (match !== null) {
    const text = match[0].replace(/\.+$/, '');
    if (text !== '') out.push({ text, start: match.index, end: match.index + text.length });
    match = scanner.exec(normalised);
  }
  return out;
}

function tokenText(tokens: readonly Token[], i: number): string {
  return tokens[i]?.text ?? '';
}

/* ----------------------------------------------------------------- pieces -- */

function meridiemAt(tokens: readonly Token[], i: number): Meridiem | null {
  const m = MERIDIEM_TOKEN.exec(tokenText(tokens, i));
  if (m === null) return null;
  return m[1] === 'p' ? 'pm' : 'am';
}

function meridiemFromSuffix(suffix: string | undefined): Meridiem | null {
  if (suffix === undefined) return null;
  return suffix.startsWith('p') ? 'pm' : 'am';
}

/** An hour spoken as a word (1–12) or written as digits (0–23). */
function readHour(tokens: readonly Token[], i: number): number | null {
  const text = tokenText(tokens, i);
  const word = HOUR_WORDS[text];
  if (word !== undefined) return word;
  if (!HOUR_DIGITS.test(text)) return null;
  const value = Number(text);
  return value <= 23 ? value : null;
}

/**
 * A minute count: "thirty", "twenty five", "oh five", and — only where the
 * grammar already guarantees a time, as in "20 past seven" — digits.
 */
function readMinutes(tokens: readonly Token[], i: number, allowDigits: boolean): Fragment | null {
  const text = tokenText(tokens, i);
  if (text === '') return null;
  const next = tokenText(tokens, i + 1);

  const tens = TENS_MINUTES[text];
  if (tens !== undefined) {
    const unit = HOUR_WORDS[next];
    if (unit !== undefined && unit <= 9) return { value: tens + unit, span: 2 };
  }

  if (text === 'oh' || text === 'o' || text === 'zero') {
    const unit = HOUR_WORDS[next];
    if (unit !== undefined && unit <= 9) return { value: unit, span: 2 };
  }

  const single = MINUTE_WORDS[text];
  if (single !== undefined) return { value: single, span: 1 };

  if (allowDigits && HOUR_DIGITS.test(text)) {
    const value = Number(text);
    if (value <= 59) return { value, span: 1 };
  }

  return null;
}

/** "quarter", "half", "twenty", "twenty five", "20" — the offset in a "past"/"to". */
function readOffset(tokens: readonly Token[], i: number): Fragment | null {
  const text = tokenText(tokens, i);
  if (text === 'quarter') return { value: 15, span: 1 };
  if (text === 'half') return { value: 30, span: 1 };
  return readMinutes(tokens, i, true);
}

function reading(hour: number, minute: number, rest: Omit<Reading, 'hour' | 'minute'>): Reading | null {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute, ...rest };
}

/** 12-hour clock plus am/pm → 0–23. Null for "13pm" and "25pm", which are not times. */
function applyMeridiem(hour: number, meridiem: Meridiem): number | null {
  if (hour < 1 || hour > 12) return null;
  const base = hour % 12;
  return meridiem === 'pm' ? base + 12 : base;
}

/* ---------------------------------------------------------------- matching -- */

/** "half past seven", "quarter to eight", "ten to eight", and British "half seven". */
function matchRelative(tokens: readonly Token[], i: number): Reading | null {
  const offset = readOffset(tokens, i);
  if (offset !== null) {
    const direction = tokenText(tokens, i + offset.span);
    const forward = direction === 'past' || direction === 'after';
    const backward = direction === 'to' || direction === 'til' || direction === 'till' || direction === 'before';
    if (forward || backward) {
      const hourIndex = i + offset.span + 1;
      const target = readHour(tokens, hourIndex);
      if (target !== null && target >= 1 && target <= 12) {
        let hour = target;
        let minute = offset.value;
        if (backward) {
          minute = 60 - offset.value;
          hour = target === 1 ? 12 : target - 1;
        }
        const meridiem = meridiemAt(tokens, hourIndex + 1);
        // "quarter to eight pm" fixes the *target* hour, and the subtraction
        // already happened, so the pm applies to the hour we landed on.
        const resolved = meridiem === null ? hour : applyMeridiem(hour, meridiem);
        if (resolved !== null) {
          const span = hourIndex + 1 - i + (meridiem === null ? 0 : 1);
          return reading(resolved, minute, { explicit: meridiem !== null, span, bare: false });
        }
      }
    }
  }

  // "half seven" is 19:30 in British English, never 06:30. The Dutch and German
  // reading (half *before* seven) is the opposite, and getting it backwards
  // would book people an hour and a half early; this parser serves a London
  // dining room, so British it is.
  if (tokenText(tokens, i) === 'half') {
    const target = readHour(tokens, i + 1);
    if (target !== null && target >= 1 && target <= 12) {
      const meridiem = meridiemAt(tokens, i + 2);
      const resolved = meridiem === null ? target : applyMeridiem(target, meridiem);
      if (resolved !== null) {
        return reading(resolved, 30, { explicit: meridiem !== null, span: meridiem === null ? 2 : 3, bare: false });
      }
    }
  }

  return null;
}

/** "seven o'clock", "seven thirty", "seven pm", and a bare "seven" or "7". */
function matchHourLed(tokens: readonly Token[], i: number): Reading | null {
  const hour = readHour(tokens, i);
  if (hour === null) return null;

  if (OCLOCK.test(tokenText(tokens, i + 1))) {
    const meridiem = meridiemAt(tokens, i + 2);
    const resolved = meridiem === null ? hour : applyMeridiem(hour, meridiem);
    if (resolved === null) return null;
    return reading(resolved, 0, {
      explicit: meridiem !== null || hour === 0 || hour > 12,
      span: meridiem === null ? 2 : 3,
      bare: false,
    });
  }

  // Digits are not accepted for the minutes here: "seven thirty" is a time,
  // but "7 30" is more often a party size followed by something else.
  const minutes = readMinutes(tokens, i + 1, false);
  if (minutes !== null) {
    const meridiem = meridiemAt(tokens, i + 1 + minutes.span);
    const resolved = meridiem === null ? hour : applyMeridiem(hour, meridiem);
    if (resolved === null) return null;
    return reading(resolved, minutes.value, {
      explicit: meridiem !== null || hour === 0 || hour > 12,
      span: 1 + minutes.span + (meridiem === null ? 0 : 1),
      bare: false,
    });
  }

  const meridiem = meridiemAt(tokens, i + 1);
  if (meridiem !== null) {
    const resolved = applyMeridiem(hour, meridiem);
    if (resolved === null) return null;
    return reading(resolved, 0, { explicit: true, span: 2, bare: false });
  }

  // A lone number. 0 and 13–23 can only be a 24-hour clock; 1–12 needs the
  // service windows to say which half of the day it belongs to.
  return reading(hour, 0, { explicit: hour === 0 || hour > 12, span: 1, bare: true });
}

/** Single-token digit forms: "7pm", "7:30pm", "19.30", "1930", "8ish". */
function matchNumeric(tokens: readonly Token[], i: number): Reading | null {
  const text = tokenText(tokens, i);

  const hhmm = HH_MM_TOKEN.exec(text);
  if (hhmm !== null) {
    const hour = Number(hhmm[1]);
    const minute = Number(hhmm[2]);
    const meridiem = meridiemFromSuffix(hhmm[3]);
    const resolved = meridiem === null ? hour : applyMeridiem(hour, meridiem);
    if (resolved === null) return null;
    return reading(resolved, minute, {
      explicit: meridiem !== null || hour === 0 || hour > 12,
      span: 1,
      bare: false,
    });
  }

  const withMeridiem = HOUR_MERIDIEM_TOKEN.exec(text);
  if (withMeridiem?.[1] !== undefined) {
    const meridiem = meridiemFromSuffix(withMeridiem[2]);
    if (meridiem === null) return null;
    const resolved = applyMeridiem(Number(withMeridiem[1]), meridiem);
    if (resolved === null) return null;
    return reading(resolved, 0, { explicit: true, span: 1, bare: false });
  }

  const ish = ISH_TOKEN.exec(text);
  if (ish?.[1] !== undefined) {
    const hour = Number(ish[1]);
    // The hedge is dropped here. Whether "8ish" should be treated as elastic is
    // the engine's call when it looks for a slot, not the parser's.
    return reading(hour, 0, { explicit: hour === 0 || hour > 12, span: 1, bare: false });
  }

  const compact = COMPACT_TOKEN.exec(text);
  if (compact?.[1] !== undefined) {
    const digits = compact[1];
    const split = digits.length === 4 ? 2 : 1;
    const hour = Number(digits.slice(0, split));
    const minute = Number(digits.slice(split));
    return reading(hour, minute, {
      explicit: hour === 0 || hour > 12,
      span: 1,
      bare: false,
    });
  }

  return null;
}

/**
 * Numbers that are almost certainly a phone fragment.
 *
 * Limits, honestly: this only catches a digit run of its own, or one sitting
 * next to another. A number dictated as "oh nine eight two…" is words, and the
 * hour words in it can still match — but the phone parser owns that turn, and
 * the last-mention rule means a real time later in the sentence still wins.
 */
function looksLikePhone(tokens: readonly Token[], i: number): boolean {
  const text = tokenText(tokens, i);
  if (text.length >= 5) return true;
  return PHONE_RUN.test(tokenText(tokens, i - 1)) || PHONE_RUN.test(tokenText(tokens, i + 1));
}

/**
 * "table for four", "party of six" — a headcount, not an hour.
 *
 * The cost of this heuristic is real and worth stating: "can we come in for 8?"
 * genuinely means eight o'clock, and this drops it. Losing a time the agent
 * then asks for is recoverable; booking four people at 04:00 is not.
 */
function precededByPartyPhrase(tokens: readonly Token[], i: number): boolean {
  const previous = tokenText(tokens, i - 1);
  if (previous === 'for') return true;
  return previous === 'of' && tokenText(tokens, i - 2) === 'party';
}

function matchAt(tokens: readonly Token[], i: number): Reading | null {
  const text = tokenText(tokens, i);
  if (text === '') return null;

  if (text === 'noon' || text === 'midday') return reading(12, 0, { explicit: true, span: 1, bare: false });
  if (text === 'midnight') return reading(0, 0, { explicit: true, span: 1, bare: false });

  if (DIGITS_ONLY.test(text) && looksLikePhone(tokens, i)) return null;

  return (
    matchTwentyFourHourWord(tokens, i) ??
    matchRelative(tokens, i) ??
    matchHourLed(tokens, i) ??
    matchNumeric(tokens, i)
  );
}

/**
 * "nineteen thirty", "twenty one hundred", "eighteen forty five".
 *
 * Always explicit — an hour above twelve has only one reading — so it never
 * reaches the window-based disambiguation.
 */
function matchTwentyFourHourWord(tokens: readonly Token[], i: number): Reading | null {
  const one = tokenText(tokens, i);
  const two = tokenText(tokens, i + 1);

  const pair = two === '' ? null : HOUR24_WORDS[`${one} ${two}`];
  const hour = pair ?? HOUR24_WORDS[one];
  if (hour === undefined) return null;
  const hourSpan = pair === undefined ? 1 : 2;

  const after = tokenText(tokens, i + hourSpan);
  if (after === 'hundred') return reading(hour, 0, { explicit: true, span: hourSpan + 1, bare: false });

  const minutes = readMinutes(tokens, i + hourSpan, true);
  if (minutes === null) return null;
  return reading(hour, minutes.value, { explicit: true, span: hourSpan + minutes.span, bare: false });
}

/* -------------------------------------------------------------- resolution -- */

function windowMinutes(days: readonly OpeningDay[]): ReadonlyArray<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (const day of days) {
    if (day.closed === true) continue;
    for (const [open, close] of day.windows ?? []) {
      const from = minutesOf(open);
      const to = minutesOf(close);
      if (!Number.isNaN(from) && !Number.isNaN(to)) out.push([from, to]);
    }
  }
  return out;
}

/**
 * The windows a bare hour is judged against.
 *
 * With a settled date it is that weekday's service. Without one — or on a day
 * the restaurant is shut, where the day itself says nothing about whether
 * "seven" is breakfast or dinner — it is every window the restaurant ever
 * opens, which still carries the shape of the place.
 */
function serviceWindows(ctx: ParseContext): ReadonlyArray<readonly [number, number]> {
  if (ctx.date !== undefined) {
    const weekday = weekdayOf(ctx.date);
    const day = ctx.config.hours.find((entry) => entry.day === weekday);
    if (day !== undefined) {
      const windows = windowMinutes([day]);
      if (windows.length > 0) return windows;
    }
  }
  return windowMinutes(ctx.config.hours);
}

function insideService(minutes: number, windows: ReadonlyArray<readonly [number, number]>): boolean {
  return windows.some(([open, close]) => minutes >= open && minutes <= close);
}

function distanceToService(minutes: number, windows: ReadonlyArray<readonly [number, number]>): number {
  let best = Number.POSITIVE_INFINITY;
  for (const [open, close] of windows) {
    if (minutes >= open && minutes <= close) return 0;
    best = Math.min(best, Math.abs(minutes - open), Math.abs(minutes - close));
  }
  return best;
}

function daypartHint(tokens: readonly Token[]): Meridiem | null {
  let found: Meridiem | null = null;
  for (const token of tokens) {
    const hint = DAYPARTS[token.text];
    if (hint === undefined) continue;
    // "morning or evening?" is the visitor thinking aloud, not a decision.
    if (found !== null && found !== hint) return null;
    found = hint;
  }
  return found;
}

function resolveBare(
  hour: number,
  minute: number,
  matched: string,
  tokens: readonly Token[],
  ctx: ParseContext,
): ParseResult<ClockTime> {
  const morning = (hour % 12) * 60 + minute;
  const evening = morning + 12 * 60;

  const hint = daypartHint(tokens);
  // Twelve is left to the windows: "twelve at night" and "twelve in the
  // afternoon" both say pm while meaning opposite ends of the clock.
  if (hint !== null && hour !== 12) {
    return parsed(timeFromMinutes(hint === 'am' ? morning : evening), matched);
  }

  const windows = serviceWindows(ctx);
  const morningOpen = insideService(morning, windows);
  const eveningOpen = insideService(evening, windows);

  if (morningOpen && !eveningOpen) return parsed(timeFromMinutes(morning), matched);
  if (eveningOpen && !morningOpen) return parsed(timeFromMinutes(evening), matched);

  if (morningOpen && eveningOpen) {
    const early = timeFromMinutes(morning);
    const late = timeFromMinutes(evening);
    return ambiguous([early, late], `"${matched}" could be ${spokenTime(early)} or ${spokenTime(late)} — both are in service.`);
  }

  // Neither reading is open. Returning the nearer one rather than dropping it
  // is the difference between "we're open from half six" and "sorry, I didn't
  // catch that" — the visitor said something perfectly clear, and the validator
  // is the layer that gets to say no. Ties go to the evening, which is where
  // the larger service is.
  const nearer = distanceToService(morning, windows) < distanceToService(evening, windows) ? morning : evening;
  return parsed(timeFromMinutes(nearer), matched);
}

/* ------------------------------------------------------------------- entry -- */

export function parseTime(text: string, ctx: ParseContext): ParseResult<ClockTime> {
  const normalised = normalise(text);
  const tokens = tokenise(normalised);

  let found: { readonly reading: Reading; readonly start: number; readonly end: number } | null = null;
  let i = 0;
  while (i < tokens.length) {
    const match = matchAt(tokens, i);
    if (match === null || (match.bare && precededByPartyPhrase(tokens, i))) {
      i += 1;
      continue;
    }
    const first = tokens[i];
    const last = tokens[i + match.span - 1];
    if (first !== undefined && last !== undefined) {
      // Last mention wins: people correct themselves mid-sentence, and the
      // correction is the one they meant.
      found = { reading: match, start: first.start, end: last.end };
    }
    i += match.span;
  }

  if (found === null) return notFound();

  const matched = normalised.slice(found.start, found.end);
  const { hour, minute, explicit } = found.reading;
  if (explicit) return parsed(timeFromMinutes(hour * 60 + minute), matched);
  return resolveBare(hour, minute, matched, tokens, ctx);
}
