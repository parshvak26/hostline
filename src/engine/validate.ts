/**
 * Per-field validation (T-026).
 *
 * This is the layer the project's central claim rests on. Everything arriving
 * here is untrusted: a tool call the model emitted, or a value the rule brain
 * parsed out of speech. Both are treated identically, because "the model
 * suggested it" is not evidence of anything (plan §7.4, rule 1).
 *
 * Three properties, all load-bearing:
 *
 *   - **Nothing throws.** Every failure is a typed {@link Rejection}. A
 *     validator that throws on hostile input is a validator that can be used to
 *     crash the page, and it would make the adversarial suite assert on stack
 *     traces instead of reasons.
 *   - **Fields are independent.** A proposal with a good date and a 5,000-
 *     character name keeps the date. Dropping the whole proposal would make the
 *     agent re-ask for things it already knows, which is the fastest way to
 *     feel robotic (R-04).
 *   - **Reasons are a closed union.** `tests/unit/adversarial.test.ts` asserts
 *     on reason names, so weakening a check breaks a test rather than silently
 *     widening what gets through.
 */

import type {
  ClockTime,
  EngineDeps,
  IsoDate,
  Rejection,
  SlotName,
  Slots,
  Validated,
} from './types.js';
import { fail, ok } from './types.js';
import { isClockTime, minutesOf, parseIsoDate } from './time.js';
import { checkDate, checkTime, isSeatable } from './availability.js';

/** Names are the only free text that reaches the screen and the transcript. */
const NAME_MAX = 60;
const NAME_ALLOWED = /^[\p{L}\p{M}'.\- ]+$/u;

const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;

/** Anything longer is a payload, not an answer. Truncated before it is shown. */
const SUPPLIED_PREVIEW = 40;

const SLOT_NAMES: readonly SlotName[] = ['date', 'time', 'partySize', 'name', 'phone'];

/**
 * A safe, short, printable rendering of whatever arrived — including objects,
 * arrays and multi-megabyte strings. Shown in the transcript's rejection list,
 * so it must never be the thing that breaks the page.
 */
export function preview(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value === null) text = 'null';
  else if (value === undefined) text = 'undefined';
  else if (typeof value === 'object') {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = '[unserialisable]';
    }
  } else text = String(value);

  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUPPLIED_PREVIEW ? `${flat.slice(0, SUPPLIED_PREVIEW)}…` : flat;
}

/* ----------------------------------------------------------------- date -- */

export function validateDate(raw: unknown, deps: EngineDeps): Validated<IsoDate> {
  if (typeof raw !== 'string') {
    return fail({
      reason: 'date_unparseable',
      field: 'date',
      supplied: preview(raw),
      detail: 'A date must be a YYYY-MM-DD string.',
    });
  }

  const trimmed = raw.trim();
  // parseIsoDate rejects the 31st of a 30-day month and the 30th of February,
  // which is the shape of hallucination a model actually produces (§12.7).
  if (parseIsoDate(trimmed) === null) {
    return fail({
      reason: 'date_unparseable',
      field: 'date',
      supplied: preview(raw),
      detail: `"${preview(raw)}" is not a date on the calendar.`,
    });
  }

  return checkDate(trimmed, deps);
}

/* ----------------------------------------------------------------- time -- */

/**
 * Format and slot-boundary checks always; opening hours, last seating and lead
 * time only once a date is known, since they are all properties of a day.
 */
export function validateTime(raw: unknown, deps: EngineDeps, date?: IsoDate): Validated<ClockTime> {
  if (typeof raw !== 'string') {
    return fail({
      reason: 'time_unparseable',
      field: 'time',
      supplied: preview(raw),
      detail: 'A time must be an HH:MM string.',
    });
  }

  const trimmed = raw.trim();
  if (!isClockTime(trimmed)) {
    return fail({
      reason: 'time_unparseable',
      field: 'time',
      supplied: preview(raw),
      detail: `"${preview(raw)}" is not a time of day.`,
    });
  }

  if (minutesOf(trimmed) % deps.config.service.slotMinutes !== 0) {
    return fail({
      reason: 'time_not_on_slot_boundary',
      field: 'time',
      supplied: trimmed,
      detail: `We seat on the ${deps.config.service.slotMinutes}-minute mark.`,
    });
  }

  if (date !== undefined && checkDate(date, deps).ok) return checkTime(date, trimmed, deps);

  return ok(trimmed);
}

/* ----------------------------------------------------------- party size -- */

export function validatePartySize(raw: unknown, deps: EngineDeps): Validated<number> {
  const { service, tables } = deps.config;

  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;

  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
    return fail({
      reason: 'party_unparseable',
      field: 'partySize',
      supplied: preview(raw),
      detail: 'A party size must be a whole number.',
    });
  }

  if (numeric < service.minPartySize) {
    return fail({
      reason: 'party_too_small',
      field: 'partySize',
      supplied: String(numeric),
      detail: `We book for ${service.minPartySize} or more.`,
    });
  }

  // Both the configured ceiling and physical seating are checked. They agree in
  // the shipped config, but a fork that raises maxPartySize without adding a
  // bigger table should still get a refusal rather than an unseatable booking.
  if (numeric > service.maxPartySize || !isSeatable(numeric, deps.config)) {
    const largest = tables.reduce((max, t) => Math.max(max, t.seats), 0);
    return fail({
      reason: 'party_too_large',
      field: 'partySize',
      supplied: String(numeric),
      detail: `Our largest table seats ${largest}.`,
    });
  }

  return ok(numeric);
}

/* ----------------------------------------------------------------- name -- */

export function validateName(raw: unknown): Validated<string> {
  if (typeof raw !== 'string') {
    return fail({
      reason: 'name_unparseable',
      field: 'name',
      supplied: preview(raw),
      detail: 'A name must be text.',
    });
  }

  // Length is checked before anything else touches the string, so a five
  // thousand character "name" costs one comparison rather than a regex pass.
  if (raw.length > NAME_MAX * 4) {
    return fail({
      reason: 'name_too_long',
      field: 'name',
      supplied: preview(raw),
      detail: `That's longer than a name — we keep it to ${NAME_MAX} characters.`,
    });
  }

  const trimmed = raw.trim().replace(/\s+/g, ' ');

  if (trimmed === '') {
    return fail({
      reason: 'name_unparseable',
      field: 'name',
      supplied: preview(raw),
      detail: 'We need a name for the booking.',
    });
  }

  if (trimmed.length > NAME_MAX) {
    return fail({
      reason: 'name_too_long',
      field: 'name',
      supplied: preview(raw),
      detail: `We keep names to ${NAME_MAX} characters.`,
    });
  }

  if (!NAME_ALLOWED.test(trimmed)) {
    return fail({
      reason: 'name_invalid_characters',
      field: 'name',
      supplied: preview(raw),
      detail: 'A name can only contain letters, spaces, hyphens and apostrophes.',
    });
  }

  return ok(trimmed);
}

/* ---------------------------------------------------------------- phone -- */

export function validatePhone(raw: unknown): Validated<string> {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return fail({
      reason: 'phone_unparseable',
      field: 'phone',
      supplied: preview(raw),
      detail: 'A phone number must be digits.',
    });
  }

  const text = String(raw);
  if (text.length > 200) {
    return fail({
      reason: 'phone_too_long',
      field: 'phone',
      supplied: preview(raw),
      detail: `A phone number is at most ${PHONE_MAX_DIGITS} digits.`,
    });
  }

  const digits = text.replace(/\D/g, '');

  if (digits === '') {
    return fail({
      reason: 'phone_unparseable',
      field: 'phone',
      supplied: preview(raw),
      detail: 'We did not catch any digits in that.',
    });
  }

  if (digits.length < PHONE_MIN_DIGITS) {
    return fail({
      reason: 'phone_too_short',
      field: 'phone',
      supplied: digits,
      detail: `A phone number needs at least ${PHONE_MIN_DIGITS} digits — we heard ${digits.length}.`,
    });
  }

  if (digits.length > PHONE_MAX_DIGITS) {
    return fail({
      reason: 'phone_too_long',
      field: 'phone',
      supplied: preview(digits),
      detail: `A phone number is at most ${PHONE_MAX_DIGITS} digits — we heard ${digits.length}.`,
    });
  }

  return ok(digits);
}

/* ------------------------------------------------------------ proposals -- */

export interface ProposalOutcome {
  /** Fields that survived. Safe to merge into state. */
  readonly accepted: Slots;
  readonly rejections: readonly Rejection[];
  /** True when the argument object itself was unusable. */
  readonly malformed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a whole `propose_slots` argument object.
 *
 * `known` is what the engine already believes, so that a time can be checked
 * against a date supplied in the same breath — "friday at seven" arrives as one
 * call, and checking the time against Friday's actual hours rather than in the
 * abstract is what makes the refusal specific enough to be useful.
 */
export function validateProposal(args: unknown, deps: EngineDeps, known: Slots = {}): ProposalOutcome {
  // Adversarial case 12: arguments arrive as a raw string rather than an
  // object. Models do this. It must be a typed rejection, not a crash.
  if (!isRecord(args)) {
    return {
      accepted: {},
      malformed: true,
      rejections: [
        {
          reason: 'malformed_arguments',
          supplied: preview(args),
          detail: 'Tool arguments must be an object of slot values.',
        },
      ],
    };
  }

  const rejections: Rejection[] = [];
  const accepted: {
    date?: IsoDate;
    time?: ClockTime;
    partySize?: number;
    name?: string;
    phone?: string;
  } = {};

  for (const key of Object.keys(args)) {
    if (!(SLOT_NAMES as readonly string[]).includes(key)) {
      rejections.push({
        reason: 'unknown_field',
        supplied: preview(key),
        detail: `"${preview(key)}" is not something we collect.`,
      });
    }
  }

  if ('date' in args && args['date'] !== undefined && args['date'] !== null) {
    const result = validateDate(args['date'], deps);
    if (result.ok) accepted.date = result.value;
    else rejections.push(result.rejection);
  }

  // The date to check the time against: whichever was just accepted, otherwise
  // whatever the conversation had already settled on.
  const dateForTime = accepted.date ?? known.date;

  if ('time' in args && args['time'] !== undefined && args['time'] !== null) {
    const result = validateTime(args['time'], deps, dateForTime);
    if (result.ok) accepted.time = result.value;
    else rejections.push(result.rejection);
  }

  if ('partySize' in args && args['partySize'] !== undefined && args['partySize'] !== null) {
    const result = validatePartySize(args['partySize'], deps);
    if (result.ok) accepted.partySize = result.value;
    else rejections.push(result.rejection);
  }

  if ('name' in args && args['name'] !== undefined && args['name'] !== null) {
    const result = validateName(args['name']);
    if (result.ok) accepted.name = result.value;
    else rejections.push(result.rejection);
  }

  if ('phone' in args && args['phone'] !== undefined && args['phone'] !== null) {
    const result = validatePhone(args['phone']);
    if (result.ok) accepted.phone = result.value;
    else rejections.push(result.rejection);
  }

  return { accepted, rejections, malformed: false };
}
