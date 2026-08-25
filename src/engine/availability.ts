/**
 * Table availability — plan §10.5, implemented exactly as specified there so
 * that it can be tested exactly.
 *
 * This is the file that makes Hostline a booking system rather than a chatbot.
 * Nothing here consults the model, and nothing here can be talked out of a
 * decision: it reads the config, counts what is already in the diary, and
 * answers yes or no. The most persuasive part of the demo is watching it say no
 * to a model that was confident.
 *
 * Three properties are worth stating because the tests depend on them:
 *
 *   - **Deterministic.** Same config, same diary, same request, same answer.
 *   - **Best fit.** A party of two never takes a six-top while a two-top is
 *     free, which is what a real host does and what makes the alternatives
 *     search produce sensible results.
 *   - **Half-open intervals.** A booking occupies `[start, start + duration)`.
 *     A table freed at 20:00 is bookable at 20:00. Getting this wrong by one
 *     minute in either direction is the classic availability bug, so the
 *     boundary cases are tested from both sides.
 */

import type {
  Alternative,
  AvailabilityRequest,
  AvailabilityResult,
  ClockTime,
  DiaryEntry,
  EngineDeps,
  IsoDate,
  Rejection,
  RestaurantConfig,
  Validated,
  Weekday,
} from './types.js';
import { fail, ok } from './types.js';
import {
  addDays,
  compareDates,
  daysBetween,
  formatDateLong,
  minutesOf,
  timeFromMinutes,
  weekdayOf,
} from './time.js';

/** How far the alternatives search wanders from the requested time. */
const ALTERNATIVE_SEARCH_MINUTES = 120;
/** How many days forward it will look once a date is hopeless. */
const ALTERNATIVE_SEARCH_DAYS = 7;
const MAX_ALTERNATIVES = 3;

type Window = readonly [ClockTime, ClockTime];

/* ------------------------------------------------------------- lookups -- */

export function windowsFor(date: IsoDate, config: RestaurantConfig): readonly Window[] {
  const weekday: Weekday = weekdayOf(date);
  const day = config.hours.find((h) => h.day === weekday);
  if (day === undefined || day.closed === true) return [];
  return day.windows ?? [];
}

export function closureOn(date: IsoDate, config: RestaurantConfig): string | null {
  const closure = config.closures.find((c) => c.date === date);
  return closure === undefined ? null : closure.reason;
}

/** Turn time for a party, in minutes. Falls back to the largest configured. */
export function turnTimeFor(partySize: number, config: RestaurantConfig): number {
  const exact = config.turnTimeMinutes[String(partySize)];
  if (exact !== undefined) return exact;
  const known = Object.values(config.turnTimeMinutes);
  return known.length === 0 ? 90 : Math.max(...known);
}

/* ----------------------------------------------------------- date rules -- */

/**
 * Step 1 of §10.5. Date-level only: the past, the horizon, closures, and days
 * the restaurant simply does not open.
 *
 * Lead time is deliberately *not* checked here, because it applies to the
 * date-and-time together — "today at nine" is fine at six o'clock and not fine
 * at half past eight, and the visitor may not have given a time yet.
 */
export function checkDate(date: IsoDate, deps: EngineDeps): Validated<IsoDate> {
  const today = deps.clock.now().date;
  const { config } = deps;

  if (compareDates(date, today) < 0) {
    return fail({
      reason: 'date_in_past',
      field: 'date',
      supplied: date,
      detail: `${formatDateLong(date)} has already gone by.`,
    });
  }

  const horizon = daysBetween(today, date);
  if (horizon > config.service.horizonDays) {
    return fail({
      reason: 'date_beyond_horizon',
      field: 'date',
      supplied: date,
      detail: `We only take bookings ${config.service.horizonDays} days ahead.`,
    });
  }

  const closureReason = closureOn(date, config);
  if (closureReason !== null) {
    return fail({
      reason: 'date_closure',
      field: 'date',
      supplied: date,
      detail: `We're closed on ${formatDateLong(date)} for ${closureReason}.`,
    });
  }

  if (windowsFor(date, config).length === 0) {
    return fail({
      reason: 'date_closed_day',
      field: 'date',
      supplied: date,
      detail: `We're closed on ${formatDateLong(date)}.`,
    });
  }

  return ok(date);
}

/* ----------------------------------------------------------- time rules -- */

/** The latest bookable minute inside a window, given the last-seating rule. */
function lastSeatingMinute(window: Window, config: RestaurantConfig): number {
  return minutesOf(window[1]) - config.policy.lastSeatingBeforeCloseMinutes;
}

/** The window containing `minute`, ignoring the last-seating cutoff. */
function windowContaining(minute: number, windows: readonly Window[]): Window | null {
  for (const window of windows) {
    if (minute >= minutesOf(window[0]) && minute <= minutesOf(window[1])) return window;
  }
  return null;
}

function describeHours(windows: readonly Window[]): string {
  return windows.map((w) => `${w[0]} to ${w[1]}`).join(' and ');
}

/**
 * Step 2 of §10.5, plus the slot-boundary and lead-time rules from §10.2.
 *
 * Assumes {@link checkDate} has already passed for this date; it does not
 * re-check closures, because a caller that skipped that step has a bug worth
 * surfacing rather than papering over.
 */
export function checkTime(date: IsoDate, time: ClockTime, deps: EngineDeps): Validated<ClockTime> {
  const { config } = deps;
  const minute = minutesOf(time);

  if (Number.isNaN(minute)) {
    return fail({
      reason: 'time_unparseable',
      field: 'time',
      supplied: time,
      detail: 'That is not a time we can read.',
    });
  }

  if (minute % config.service.slotMinutes !== 0) {
    return fail({
      reason: 'time_not_on_slot_boundary',
      field: 'time',
      supplied: time,
      detail: `We seat on the ${config.service.slotMinutes}-minute mark.`,
    });
  }

  const windows = windowsFor(date, config);
  const window = windowContaining(minute, windows);
  if (window === null) {
    return fail({
      reason: 'time_outside_hours',
      field: 'time',
      supplied: time,
      detail:
        windows.length === 0
          ? `We're closed on ${formatDateLong(date)}.`
          : `On ${formatDateLong(date)} we're open ${describeHours(windows)}.`,
    });
  }

  if (minute > lastSeatingMinute(window, config)) {
    return fail({
      reason: 'time_after_last_seating',
      field: 'time',
      supplied: time,
      detail: `Our last seating is ${timeFromMinutes(lastSeatingMinute(window, config))}.`,
    });
  }

  // Lead time, checked against the real clock rather than the calendar day, so
  // that "today at seven" behaves correctly at half past six.
  const now = deps.clock.now();
  const minutesFromNow = daysBetween(now.date, date) * 24 * 60 + (minute - minutesOf(now.time));
  if (minutesFromNow < config.service.leadTimeMinutes) {
    return fail({
      reason: 'time_before_lead_time',
      field: 'time',
      supplied: time,
      detail: `We need ${config.service.leadTimeMinutes} minutes' notice.`,
    });
  }

  return ok(time);
}

/* ------------------------------------------------------------ allocation -- */

/** Half-open overlap: `[aStart, aEnd)` against `[bStart, bEnd)`. */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Steps 3–5 and 7 of §10.5.
 *
 * Returns the table class id, not a specific table. The room has `count`
 * interchangeable tables of each class, so "is one of the five four-tops free"
 * is the only question worth asking, and it is answered by counting overlaps.
 */
function allocate(request: AvailabilityRequest, deps: EngineDeps): string | null {
  const { config, diary } = deps;
  const duration = turnTimeFor(request.partySize, config);
  const start = minutesOf(request.time);
  const end = start + duration;

  // Best fit: smallest table that seats the party, tried first. Combining is
  // off for MVP (§10.5 step 7), so a party of seven needs a single seven-seat
  // table, has none, and is escalated rather than quietly seated at a six-top.
  const candidates = config.tables
    .filter((t) => t.seats >= request.partySize)
    .slice()
    .sort((a, b) => a.seats - b.seats || a.id.localeCompare(b.id));

  for (const table of candidates) {
    const taken = diary.filter(
      (entry: DiaryEntry) =>
        entry.date === request.date &&
        entry.tableId === table.id &&
        overlaps(start, end, minutesOf(entry.time), minutesOf(entry.time) + entry.durationMinutes),
    ).length;

    if (taken < table.count) return table.id;
  }

  return null;
}

/** Whether a party could ever be seated, ignoring the diary entirely. */
export function isSeatable(partySize: number, config: RestaurantConfig): boolean {
  if (config.policy.combineTables) {
    const total = config.tables.reduce((sum, t) => sum + t.seats * t.count, 0);
    return partySize <= total;
  }
  return config.tables.some((t) => t.seats >= partySize);
}

/* ---------------------------------------------------------- alternatives -- */

/** Every bookable time on a date, in order. */
function bookableTimes(date: IsoDate, config: RestaurantConfig): ClockTime[] {
  const step = config.service.slotMinutes;
  const times: ClockTime[] = [];
  for (const window of windowsFor(date, config)) {
    const first = Math.ceil(minutesOf(window[0]) / step) * step;
    const last = lastSeatingMinute(window, config);
    for (let m = first; m <= last; m += step) times.push(timeFromMinutes(m));
  }
  return times;
}

/**
 * Step 6 of §10.5.
 *
 * Searches outward from the requested time in slot-sized steps, up to two hours
 * either side, taking the earlier option when two are equidistant. If the date
 * is hopeless it offers the same time on the nearest date within a week.
 *
 * The ordering matters more than it looks: a host who offers "half six or
 * eight" when you asked for seven sounds like they checked, and one who offers
 * "nine fifteen or half eleven" sounds like they didn't.
 */
export function findAlternatives(
  request: AvailabilityRequest,
  deps: EngineDeps,
  limit: number = MAX_ALTERNATIVES,
): Alternative[] {
  const { config } = deps;
  if (limit <= 0 || !isSeatable(request.partySize, config)) return [];

  const found: Alternative[] = [];
  const step = config.service.slotMinutes;

  // Snap to the slot grid before stepping outward.
  //
  // A request for 19:07 is refused for not being on a boundary, but the visitor
  // still deserves an answer better than silence. Stepping in whole slots from
  // 19:07 lands on 18:52, 19:22, 18:37 — none of which are bookable times, so
  // the search would find nothing at all and the agent would say "we're full"
  // when it means "we seat on the quarter hour".
  const raw = minutesOf(request.time);
  const requested = Number.isNaN(raw) ? Number.NaN : Math.round(raw / step) * step;
  if (Number.isNaN(requested)) return [];

  // Same date, nearest first, earlier winning ties.
  if (checkDate(request.date, deps).ok) {
    const onDate = new Set(bookableTimes(request.date, config));
    for (let offset = step; offset <= ALTERNATIVE_SEARCH_MINUTES && found.length < limit; offset += step) {
      for (const candidateMinute of [requested - offset, requested + offset]) {
        if (found.length >= limit) break;
        if (candidateMinute < 0 || candidateMinute >= 24 * 60) continue;
        const time = timeFromMinutes(candidateMinute);
        if (!onDate.has(time)) continue;
        const probe = { date: request.date, time, partySize: request.partySize };
        if (!checkTime(request.date, time, deps).ok) continue;
        if (allocate(probe, deps) !== null) found.push({ date: request.date, time });
      }
    }
  }

  if (found.length > 0) return found;

  // Nothing on the day: the same time on the nearest date that can take it.
  for (let ahead = 1; ahead <= ALTERNATIVE_SEARCH_DAYS && found.length < limit; ahead += 1) {
    const date = addDays(request.date, ahead);
    if (!checkDate(date, deps).ok) continue;
    if (!checkTime(date, request.time, deps).ok) continue;
    const probe = { date, time: request.time, partySize: request.partySize };
    if (allocate(probe, deps) !== null) found.push({ date, time: request.time });
  }

  return found;
}

/* -------------------------------------------------------------- the API -- */

function refusal(rejection: Rejection, request: AvailabilityRequest, deps: EngineDeps): AvailabilityResult {
  return { available: false, rejection, alternatives: findAlternatives(request, deps) };
}

/**
 * The whole of §10.5 in one call: the only question the rest of the system is
 * allowed to ask about whether a table exists.
 */
export function checkAvailability(request: AvailabilityRequest, deps: EngineDeps): AvailabilityResult {
  const { config } = deps;

  const dateCheck = checkDate(request.date, deps);
  if (!dateCheck.ok) {
    // A closed or past date has no useful "nearby time"; the alternatives
    // search will fall through to the next open date on its own.
    return refusal(dateCheck.rejection, request, deps);
  }

  const timeCheck = checkTime(request.date, request.time, deps);
  if (!timeCheck.ok) return refusal(timeCheck.rejection, request, deps);

  if (request.partySize < config.service.minPartySize) {
    return {
      available: false,
      rejection: {
        reason: 'party_too_small',
        field: 'partySize',
        supplied: String(request.partySize),
        detail: `We book for ${config.service.minPartySize} or more.`,
      },
      alternatives: [],
    };
  }

  if (request.partySize > config.service.maxPartySize || !isSeatable(request.partySize, config)) {
    return {
      available: false,
      rejection: {
        reason: 'party_too_large',
        field: 'partySize',
        supplied: String(request.partySize),
        detail: `Our largest table seats ${Math.max(...config.tables.map((t) => t.seats))}.`,
      },
      alternatives: [],
    };
  }

  const tableId = allocate(request, deps);
  if (tableId === null) {
    return refusal(
      {
        reason: 'no_availability',
        supplied: `${request.date} ${request.time} for ${request.partySize}`,
        detail: `We're fully booked at ${request.time} on ${formatDateLong(request.date)}.`,
      },
      request,
      deps,
    );
  }

  return { available: true, tableId, durationMinutes: turnTimeFor(request.partySize, config) };
}
