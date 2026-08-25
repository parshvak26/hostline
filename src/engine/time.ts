/**
 * Civil date and time arithmetic, with no `Date` anywhere.
 *
 * The engine is forbidden from touching the ambient clock (R-43), and the
 * booking domain is entirely civil anyway: "Friday the 28th at 19:00" in the
 * restaurant's own timezone. Once the adapter has resolved *now* into a local
 * `YYYY-MM-DD` / `HH:MM` pair, everything downstream is integer arithmetic on
 * the proleptic Gregorian calendar — which is exactly what makes the
 * availability tests able to assert exact interval boundaries.
 *
 * Timezone conversion happens once, in `src/agent/clock.ts`, using `Intl`.
 * Nothing in here knows what a timezone is.
 */

import type { ClockTime, IsoDate, Weekday } from './types.js';

export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const WEEKDAY_NAMES: Readonly<Record<Weekday, string>> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export const MONTH_NAMES: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_TIME = /^(\d{2}):(\d{2})$/;

/* ------------------------------------------------------------- calendar -- */

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in `month` (1-indexed) of `year`. */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1] ?? 0;
}

export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Parses `YYYY-MM-DD`, rejecting dates the calendar does not contain. */
export function parseIsoDate(value: string): CivilDate | null {
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function isIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}

export function toIsoDate(date: CivilDate): IsoDate {
  const mm = String(date.month).padStart(2, '0');
  const dd = String(date.day).padStart(2, '0');
  return `${String(date.year).padStart(4, '0')}-${mm}-${dd}`;
}

/**
 * Days since 1970-01-01, by Howard Hinnant's `days_from_civil`. Chosen over a
 * loop because it is exact for any year and has no branches to get wrong.
 */
export function toDayNumber(iso: IsoDate): number {
  const civil = parseIsoDate(iso);
  if (!civil) return Number.NaN;
  const { month, day } = civil;
  const y = civil.year - (month <= 2 ? 1 : 0);
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400; // [0, 399]
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** Inverse of {@link toDayNumber}. */
export function fromDayNumber(days: number): IsoDate {
  const z = days + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const month = mp + (mp < 10 ? 3 : -9); // [1, 12]
  return toIsoDate({ year: y + (month <= 2 ? 1 : 0), month, day });
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return fromDayNumber(toDayNumber(iso) + days);
}

/** Positive when `a` is later than `b`. */
export function compareDates(a: IsoDate, b: IsoDate): number {
  return toDayNumber(a) - toDayNumber(b);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return toDayNumber(to) - toDayNumber(from);
}

export function weekdayOf(iso: IsoDate): Weekday {
  // 1970-01-01 was a Thursday, which is index 3 in a Monday-first week.
  const index = (((toDayNumber(iso) + 3) % 7) + 7) % 7;
  return WEEKDAYS[index] ?? 'mon';
}

/* ----------------------------------------------------------------- time -- */

export function isClockTime(value: string): boolean {
  const m = CLOCK_TIME.exec(value);
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

/** `HH:MM` → minutes past midnight. `NaN` for anything malformed. */
export function minutesOf(time: ClockTime): number {
  const m = CLOCK_TIME.exec(time);
  if (!m) return Number.NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return Number.NaN;
  return h * 60 + min;
}

/** Minutes past midnight → `HH:MM`. Values outside a day are clamped. */
export function timeFromMinutes(minutes: number): ClockTime {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Minutes from `{date, time}` to `{date, time}`, across day boundaries. */
export function minutesBetween(
  fromDate: IsoDate,
  fromTime: ClockTime,
  toDate: IsoDate,
  toTime: ClockTime,
): number {
  return daysBetween(fromDate, toDate) * 24 * 60 + (minutesOf(toTime) - minutesOf(fromTime));
}

/* --------------------------------------------------------------- spoken -- */

export function ordinal(n: number): string {
  const abs = Math.abs(Math.trunc(n));
  const tens = abs % 100;
  if (tens >= 11 && tens <= 13) return `${abs}th`;
  switch (abs % 10) {
    case 1:
      return `${abs}st`;
    case 2:
      return `${abs}nd`;
    case 3:
      return `${abs}rd`;
    default:
      return `${abs}th`;
  }
}

/**
 * How a receptionist would say a date out loud, relative to today.
 *
 * "tomorrow" beats "Wednesday the 26th" when it is in fact tomorrow — that is
 * the difference between sounding like a person and sounding like a form.
 */
export function spokenDate(iso: IsoDate, today: IsoDate): string {
  const delta = daysBetween(today, iso);
  if (delta === 0) return 'today';
  if (delta === 1) return 'tomorrow';
  const civil = parseIsoDate(iso);
  if (!civil) return iso;
  const weekday = WEEKDAY_NAMES[weekdayOf(iso)];
  if (delta > 1 && delta <= 6) return `${weekday} the ${ordinal(civil.day)}`;
  const month = MONTH_NAMES[civil.month - 1] ?? '';
  return `${weekday} the ${ordinal(civil.day)} of ${month}`;
}

/** "Friday 28 August" — for the diary and the confirmation card, not speech. */
export function formatDateLong(iso: IsoDate): string {
  const civil = parseIsoDate(iso);
  if (!civil) return iso;
  return `${WEEKDAY_NAMES[weekdayOf(iso)]} ${civil.day} ${MONTH_NAMES[civil.month - 1] ?? ''}`.trim();
}

/**
 * "7pm", "half past seven", "7:20pm".
 *
 * Half and quarter hours get the spoken form because that is how people say
 * them; anything else falls back to digits, which a synthesiser reads fine.
 */
export function spokenTime(time: ClockTime): string {
  const total = minutesOf(time);
  if (Number.isNaN(total)) return time;
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const suffix = h24 < 12 ? 'am' : 'pm';
  if (m === 0) return `${h12}${suffix}`;
  if (m === 30) return `half past ${h12}`;
  if (m === 15) return `quarter past ${h12}`;
  if (m === 45) {
    const next = (h12 % 12) + 1;
    return `quarter to ${next}`;
  }
  return `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

/** "7:00 pm" — for the screen, where digits read faster than words. */
export function formatTime12(time: ClockTime): string {
  const total = minutesOf(time);
  if (Number.isNaN(total)) return time;
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'am' : 'pm'}`;
}
