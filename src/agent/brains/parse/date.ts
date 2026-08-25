/**
 * Dates, the way people say them out loud.
 *
 * The parser reports what it understood and nothing more. It does not care
 * whether the date is in the past, on a closing day, or past the booking
 * horizon — `src/engine/validate.ts` owns all of that (plan §7.2), and a
 * parser that silently declined to hear "yesterday" would rob the validator of
 * the chance to say *why* it cannot be booked.
 *
 * The one place a direction unavoidably leaks in is resolution. "The 28th" has
 * to become some particular 28th, and the only reading a caller can act on is
 * the next one. That is a parsing decision, not a policy one.
 */

import type { ClockTime, IsoDate, Weekday } from '../../../engine/types.js';
import {
  MONTH_NAMES,
  WEEKDAYS,
  addDays,
  compareDates,
  daysBetween,
  daysInMonth,
  minutesOf,
  parseIsoDate,
  toIsoDate,
  weekdayOf,
} from '../../../engine/time.js';
import { ORDINALS, phraseToNumber, wordToNumber } from './words.js';
import type { ParseContext, ParseResult } from './types.js';
import { ambiguous, normalise, notFound, parsed } from './types.js';

/* ------------------------------------------------------------ vocabulary -- */

const WEEKDAY_ALIASES: ReadonlyArray<readonly [string, Weekday]> = [
  ['monday', 'mon'],
  ['mon', 'mon'],
  ['tuesday', 'tue'],
  ['tues', 'tue'],
  ['tue', 'tue'],
  ['wednesday', 'wed'],
  ['weds', 'wed'],
  ['wed', 'wed'],
  ['thursday', 'thu'],
  ['thurs', 'thu'],
  ['thur', 'thu'],
  ['thu', 'thu'],
  ['friday', 'fri'],
  ['fri', 'fri'],
  ['saturday', 'sat'],
  ['sat', 'sat'],
  ['sunday', 'sun'],
  ['sun', 'sun'],
];

const DAYS_OF_WEEK = new Map<string, Weekday>(WEEKDAY_ALIASES);

/** Month names and their three-letter forms, derived so the two never drift. */
function buildMonthLookup(): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  MONTH_NAMES.forEach((name, index) => {
    const lower = name.toLowerCase();
    map.set(lower, index + 1);
    map.set(lower.slice(0, 3), index + 1);
  });
  map.set('sept', 9);
  return map;
}

const MONTHS = buildMonthLookup();

/** Longest alternative first, so `jun` never wins against `june`. */
function alternation(words: Iterable<string>): string {
  return [...words].sort((a, b) => b.length - a.length).join('|');
}

const WEEKDAY_ALT = alternation(DAYS_OF_WEEK.keys());
const MONTH_ALT = alternation(MONTHS.keys());

const ORDINAL_UNIT_WORDS = Object.entries(ORDINALS)
  .filter(([, value]) => value >= 1 && value <= 9)
  .map(([word]) => word);

// "twenty-eighth" is spelled as tens plus a unit ordinal, so it needs its own
// branch ahead of the plain ordinals or the regex settles for "eighth".
const DAY_WORD = `(?:twenty|thirty)[- ](?:${ORDINAL_UNIT_WORDS.join('|')})|${alternation(Object.keys(ORDINALS))}`;

/** A day someone has explicitly marked as a day: "28th", "twenty-eighth". */
const DAY_ORDINAL = `(?:\\d{1,2}(?:st|nd|rd|th)|${DAY_WORD})`;

/** Anything that could be a day when a month name is standing next to it. */
const DAY_ANY = `(?:\\d{1,2}(?:st|nd|rd|th)|\\d{1,2}|${DAY_WORD})`;

const PART_OF_DAY = '(?:\\s+(?:morning|afternoon|evening|night|lunchtime))?';

/* --------------------------------------------------------------- helpers -- */

/**
 * Whether the restaurant could still seat someone on `date`, given the clock.
 *
 * This exists for one question only: when a bare weekday or a bare
 * day-of-month lands on today, did the visitor mean today? Someone saying
 * "Friday" at midnight on a Friday means the next one. The cutoff is the end of
 * the day's last service window — the lead-time and last-seating margins are
 * the validator's business, and applying them here would be policy.
 */
function couldStillSeat(ctx: ParseContext, date: IsoDate): boolean {
  const day = ctx.config.hours.find((entry) => entry.day === weekdayOf(date));
  if (day === undefined || day.closed === true) return false;
  const windows = day.windows ?? [];
  const close: ClockTime | undefined = windows[windows.length - 1]?.[1];
  if (close === undefined) return false;
  const now = minutesOf(ctx.nowTime);
  const end = minutesOf(close);
  if (Number.isNaN(now) || Number.isNaN(end)) return false;
  return now < end;
}

/** Monday, because `WEEKDAYS` is Monday-first and weeks have to start somewhere. */
function startOfWeek(date: IsoDate): IsoDate {
  return addDays(date, -WEEKDAYS.indexOf(weekdayOf(date)));
}

/** The next `target`, strictly after today unless today can still be seated. */
function nextOccurrence(ctx: ParseContext, target: Weekday): IsoDate {
  const delta = (WEEKDAYS.indexOf(target) - WEEKDAYS.indexOf(weekdayOf(ctx.today)) + 7) % 7;
  if (delta === 0 && !couldStillSeat(ctx, ctx.today)) return addDays(ctx.today, 7);
  return addDays(ctx.today, delta);
}

/**
 * "Next Friday" reads as the Friday of the *following* calendar week.
 *
 * English genuinely does not settle this: on a Tuesday, half the country means
 * the Friday three days away and the other half means the one ten days away.
 * The house rule everywhere else in this codebase is to return `ambiguous`
 * rather than guess, but a `next <weekday>` that always asked a clarifying
 * question would make the agent exhausting to talk to for the one phrase people
 * use most. So: "Friday" is the near one, "next Friday" is the far one, and the
 * distinction is at least self-consistent. The read-back says the date out loud,
 * which is where a misunderstanding gets caught.
 */
function occurrenceNextWeek(ctx: ParseContext, target: Weekday): IsoDate {
  return addDays(startOfWeek(addDays(ctx.today, 7)), WEEKDAYS.indexOf(target));
}

/**
 * A month and day, with the year either given or resolved forward.
 *
 * The forward search runs over several years rather than one so that "the
 * twenty-ninth of February" lands on the next leap day instead of failing.
 */
function monthDayToIso(ctx: ParseContext, month: number, day: number, year: number | undefined): IsoDate | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year !== undefined) {
    if (day > daysInMonth(year, month)) return null;
    return toIsoDate({ year, month, day });
  }

  const start = parseIsoDate(ctx.today);
  if (start === null) return null;
  for (let year_ = start.year; year_ <= start.year + 8; year_ += 1) {
    if (day > daysInMonth(year_, month)) continue;
    const iso = toIsoDate({ year: year_, month, day });
    if (compareDates(iso, ctx.today) >= 0) return iso;
  }
  return null;
}

/**
 * A bare day-of-month, resolved to its next occurrence.
 *
 * Months that do not contain the day are skipped — the 31st said in September
 * means October. The scan stops at the configured horizon, which is used here
 * purely as a stopping point: an unbounded search would happily return a date
 * years out for "the 35th" rather than admitting it understood nothing.
 */
function dayOfMonthToIso(ctx: ParseContext, day: number): IsoDate | null {
  if (day < 1 || day > 31) return null;
  const start = parseIsoDate(ctx.today);
  if (start === null) return null;

  const horizon = ctx.config.service.horizonDays;
  let year = start.year;
  let month = start.month;

  for (let step = 0; step < 14; step += 1) {
    if (step > 0 && daysBetween(ctx.today, toIsoDate({ year, month, day: 1 })) > horizon) break;
    if (day <= daysInMonth(year, month)) {
      const iso = toIsoDate({ year, month, day });
      const delta = daysBetween(ctx.today, iso);
      if (delta > 0 || (delta === 0 && couldStillSeat(ctx, iso))) return iso;
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return null;
}

/**
 * "Friday the 28th" — both halves have to agree.
 *
 * A weekday and a day-of-month only coincide every few years, so the search is
 * capped at the horizon. Beyond that the combination is far likelier to be a
 * mishearing than a booking, and `none` lets the agent ask rather than confirm
 * a date in 2031.
 */
function weekdayAndDayToIso(ctx: ParseContext, target: Weekday, day: number): IsoDate | null {
  for (let offset = 0; offset <= ctx.config.service.horizonDays; offset += 1) {
    const iso = addDays(ctx.today, offset);
    if (offset === 0 && !couldStillSeat(ctx, iso)) continue;
    const civil = parseIsoDate(iso);
    if (civil === null) continue;
    if (civil.day === day && weekdayOf(iso) === target) return iso;
  }
  return null;
}

function found(iso: IsoDate | null, matched: string): ParseResult<IsoDate> {
  return iso === null ? notFound() : parsed(iso, matched);
}

function dayValue(token: string | undefined): number | null {
  return token === undefined ? null : wordToNumber(token);
}

function weekdayValue(token: string | undefined): Weekday | undefined {
  return token === undefined ? undefined : DAYS_OF_WEEK.get(token);
}

function monthValue(token: string | undefined): number | undefined {
  return token === undefined ? undefined : MONTHS.get(token);
}

/* ----------------------------------------------------------------- rules -- */

interface Rule {
  readonly pattern: RegExp;
  readonly resolve: (m: RegExpExecArray, ctx: ParseContext) => ParseResult<IsoDate>;
}

const RULES: readonly Rule[] = [
  // `2026-08-28` straight through. An impossible ISO date is a `none`, not a
  // nearby date: whoever emitted it was a machine, and machines get told.
  {
    pattern: /\b\d{4}-\d{2}-\d{2}\b/g,
    resolve: (m) => (parseIsoDate(m[0]) === null ? notFound() : parsed(m[0], m[0])),
  },

  // `28/8`, `28-08`, `28/08/2026`, `28/08/26`.
  //
  // Day first. The restaurant is in Bandra and `en-IN` leads its locale list,
  // where 8/9 is the eighth of September. The lookarounds stop this matching
  // the tail of an ISO date.
  {
    pattern: /(?<![\d/-])(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?(?![\d/-])/g,
    resolve: (m, ctx) => {
      const first = Number(m[1]);
      const second = Number(m[2]);
      // 8/28 has no day-first reading at all, so the only thing left to hear is
      // the American order. Repairing an impossible parse is not the same as
      // guessing between two possible ones.
      const dayFirst = !(first <= 12 && second > 12);
      const day = dayFirst ? first : second;
      const month = dayFirst ? second : first;
      const rawYear = m[3];
      const year =
        rawYear === undefined ? undefined : rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
      return found(monthDayToIso(ctx, month, day, year), m[0]);
    },
  },

  // `28 august`, `28th of august`, `the twenty-eighth of august 2027`.
  {
    pattern: new RegExp(`\\b(?:the\\s+)?(${DAY_ANY})\\s+(?:of\\s+)?(${MONTH_ALT})\\b(?:\\s+(\\d{4}))?`, 'g'),
    resolve: (m, ctx) => {
      const day = dayValue(m[1]);
      const month = monthValue(m[2]);
      const year = m[3] === undefined ? undefined : Number(m[3]);
      if (day === null || month === undefined) return notFound();
      return found(monthDayToIso(ctx, month, day, year), m[0]);
    },
  },

  // `august 28`, `aug 28th`, `august the 28th 2027`.
  {
    pattern: new RegExp(`\\b(${MONTH_ALT})\\s+(?:the\\s+)?(${DAY_ANY})\\b(?:\\s+(\\d{4}))?`, 'g'),
    resolve: (m, ctx) => {
      const month = monthValue(m[1]);
      const day = dayValue(m[2]);
      const year = m[3] === undefined ? undefined : Number(m[3]);
      if (day === null || month === undefined) return notFound();
      return found(monthDayToIso(ctx, month, day, year), m[0]);
    },
  },

  // `friday the 28th`. Deliberately not allowed to fall back to the weekday
  // alone when the two halves disagree — see `weekdayAndDayToIso`.
  {
    pattern: new RegExp(`\\b(?:on\\s+)?(${WEEKDAY_ALT})\\s+(?:the\\s+)?(${DAY_ORDINAL})\\b`, 'g'),
    resolve: (m, ctx) => {
      const target = weekdayValue(m[1]);
      const day = dayValue(m[2]);
      if (target === undefined || day === null) return notFound();
      return found(weekdayAndDayToIso(ctx, target, day), m[0]);
    },
  },

  {
    pattern: new RegExp(`\\bnext\\s+(${WEEKDAY_ALT})\\b`, 'g'),
    resolve: (m, ctx) => {
      const target = weekdayValue(m[1]);
      if (target === undefined) return notFound();
      return parsed(occurrenceNextWeek(ctx, target), m[0]);
    },
  },

  {
    pattern: new RegExp(`\\b(?:on\\s+|this\\s+coming\\s+|this\\s+|coming\\s+)?(${WEEKDAY_ALT})\\b`, 'g'),
    resolve: (m, ctx) => {
      const target = weekdayValue(m[1]);
      if (target === undefined) return notFound();
      return parsed(nextOccurrence(ctx, target), m[0]);
    },
  },

  // Swallows the trailing part-of-day so that "the day after tomorrow evening"
  // outruns the bare "tomorrow evening" sitting inside it.
  {
    pattern: new RegExp(`\\b(?:the\\s+)?day after tomorrow${PART_OF_DAY}`, 'g'),
    resolve: (m, ctx) => parsed(addDays(ctx.today, 2), m[0]),
  },

  {
    pattern: new RegExp(`\\btomorrow${PART_OF_DAY}`, 'g'),
    resolve: (m, ctx) => parsed(addDays(ctx.today, 1), m[0]),
  },

  // "Tonight" names today however late it is. Whether the kitchen is still open
  // is exactly the thing the validator is there to say.
  {
    pattern: /\b(?:today|tonight|this\s+(?:morning|afternoon|evening|lunchtime))\b/g,
    resolve: (m, ctx) => parsed(ctx.today, m[0]),
  },

  {
    pattern: /\byesterday\b/g,
    resolve: (m, ctx) => parsed(addDays(ctx.today, -1), m[0]),
  },

  {
    pattern: /\bnext\s+weekend\b/g,
    resolve: (_m, ctx) => {
      const saturday = addDays(nextOccurrence(ctx, 'sat'), 7);
      return ambiguous([saturday, addDays(saturday, 1)], 'A weekend is two days; which one?');
    },
  },

  // "This weekend" is two dates and the plan forbids picking one. On a Sunday it
  // reads forward to the next Saturday, since a visitor who meant today would
  // have said today.
  {
    pattern: /\b(?:this\s+coming\s+|this\s+|the\s+|coming\s+)?weekend\b/g,
    resolve: (_m, ctx) => {
      const saturday = nextOccurrence(ctx, 'sat');
      return ambiguous([saturday, addDays(saturday, 1)], 'A weekend is two days; which one?');
    },
  },

  // "Next week" names a span, not a day. Seven candidates is a lot, but it is
  // honest, and the caller's job is to ask rather than to pick.
  {
    pattern: /\bnext\s+week\b/g,
    resolve: (_m, ctx) => {
      const monday = startOfWeek(addDays(ctx.today, 7));
      const week = WEEKDAYS.map((_day, index) => addDays(monday, index));
      return ambiguous(week, 'Next week covers seven days; which one?');
    },
  },

  // "In three days", "in a week", "in a fortnight" — an offset, not a span, so
  // these resolve to a single date.
  {
    pattern: /\bin\s+([a-z0-9-]+(?:\s+[a-z]+)?)\s+(days?|weeks?|fortnights?)\b/g,
    resolve: (m, ctx) => {
      const rawCount = m[1];
      const unit = m[2];
      if (rawCount === undefined || unit === undefined) return notFound();
      const count = rawCount === 'a' || rawCount === 'an' ? 1 : phraseToNumber(rawCount);
      if (count === null || !Number.isInteger(count) || count < 0) return notFound();
      const perUnit = unit.startsWith('week') ? 7 : unit.startsWith('fortnight') ? 14 : 1;
      return parsed(addDays(ctx.today, count * perUnit), m[0]);
    },
  },

  // `the 28th`, `28th`, `on the twenty-eighth`. A bare "the 4" is deliberately
  // not a date — "the 4 of us" is a party size, and this parser has no business
  // stealing it.
  {
    pattern: new RegExp(`\\b(?:on\\s+)?the\\s+(${DAY_ORDINAL})\\b`, 'g'),
    resolve: (m, ctx) => {
      const day = dayValue(m[1]);
      if (day === null) return notFound();
      return found(dayOfMonthToIso(ctx, day), m[0]);
    },
  },

  {
    pattern: /\b(\d{1,2}(?:st|nd|rd|th))\b/g,
    resolve: (m, ctx) => {
      const day = dayValue(m[1]);
      if (day === null) return notFound();
      return found(dayOfMonthToIso(ctx, day), m[0]);
    },
  },
];

/* ---------------------------------------------------------------- parser -- */

interface Candidate {
  readonly end: number;
  readonly length: number;
  readonly result: () => ParseResult<IsoDate>;
}

/**
 * Finds every date-shaped phrase and keeps the one that ends latest.
 *
 * Ending latest, rather than starting latest, is what makes "the day after
 * tomorrow" beat the "tomorrow" nested inside it while still letting
 * "Thursday, sorry, Friday" land on Friday. Ties go to the longer phrase, which
 * is how "next Friday" wins over "Friday".
 *
 * The winner's reading is final. "Friday the 31st" resolving to nothing is a
 * `none`, not permission to throw away half of what was said.
 */
export function parseDate(text: string, ctx: ParseContext): ParseResult<IsoDate> {
  const normalised = normalise(text);
  if (normalised === '') return notFound();

  let best: Candidate | null = null;

  for (const rule of RULES) {
    for (const match of normalised.matchAll(rule.pattern)) {
      const matched = match[0];
      if (matched === '') continue;
      const end = match.index + matched.length;
      if (best !== null && (end < best.end || (end === best.end && matched.length <= best.length))) continue;
      best = { end, length: matched.length, result: () => rule.resolve(match, ctx) };
    }
  }

  return best === null ? notFound() : best.result();
}
