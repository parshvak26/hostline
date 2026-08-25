/**
 * Confirmation policy (T-029) — the last gate before a booking exists.
 *
 * Two rules, and the whole of R-05 is these two rules:
 *
 *   1. Nothing is committed without a read-back the visitor answered yes to.
 *   2. Any slot changing after that read-back voids it. The agent asks again.
 *
 * The affirmation is classified **here**, from the visitor's own words, rather
 * than being taken from the brain. That distinction is the difference between
 * adversarial case 3 passing and failing: a model can claim the visitor agreed,
 * but it cannot make `"no, seven's too early"` classify as yes.
 */

import type {
  Affirmation,
  BookingDraft,
  EngineDeps,
  EngineState,
  LineParams,
  Slots,
} from './types.js';
import { formatDateLong, spokenDate, spokenTime } from './time.js';

/**
 * Word lists, deliberately ordered negative-first.
 *
 * "no thanks" contains "thanks", and "yeah, no" is a real thing people say.
 * Checking for refusal before agreement means the ambiguous cases fall to the
 * safe side, which for a booking means not booking.
 */
const NEGATIVE = [
  'no',
  'nope',
  'nah',
  'not',
  "don't",
  'dont',
  'wrong',
  'incorrect',
  'change',
  'actually',
  'wait',
  'hold on',
  'hang on',
  'cancel',
  'never mind',
  'nevermind',
  'scrap that',
  'forget it',
];

const AFFIRMATIVE = [
  'yes',
  'yeah',
  'yep',
  'yup',
  'ya',
  'sure',
  'correct',
  'right',
  'perfect',
  'lovely',
  'great',
  'sounds good',
  'go ahead',
  'book it',
  'do it',
  'please do',
  'that works',
  "that's it",
  'thats it',
  'confirm',
  'ok',
  'okay',
];

const ABANDON = ['cancel', 'never mind', 'nevermind', 'forget it', 'no thanks', 'not now', 'leave it'];

function containsPhrase(haystack: string, needle: string): boolean {
  // Word-boundary matching, so "notice" is not a "no" and "yesterday" is not a
  // "yes". Multi-word phrases are matched literally.
  if (needle.includes(' ')) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(haystack);
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classify a visitor turn as agreement, refusal, or neither.
 *
 * `none` is a real answer and the common one: "seven thirty" in response to a
 * read-back is a correction, not a yes. Treating it as agreement would book the
 * wrong table, which is the failure this whole project is arranged to prevent.
 */
export function classifyAffirmation(text: string): Affirmation {
  const normalised = normalise(text);
  if (normalised === '') return 'none';

  for (const phrase of NEGATIVE) {
    if (containsPhrase(normalised, phrase)) return 'no';
  }
  for (const phrase of AFFIRMATIVE) {
    if (containsPhrase(normalised, phrase)) return 'yes';
  }
  return 'none';
}

/** "cancel", "never mind" — an explicit end, distinct from disagreeing. */
export function isAbandonment(text: string): boolean {
  const normalised = normalise(text);
  return ABANDON.some((phrase) => containsPhrase(normalised, phrase));
}

/* ------------------------------------------------------------- read-back -- */

/** Every slot filled and independently accepted by the engine. */
export function slotsComplete(state: EngineState): boolean {
  const { slots, slotStates } = state;
  return (
    slots.date !== undefined &&
    slots.time !== undefined &&
    slots.partySize !== undefined &&
    slots.name !== undefined &&
    slots.phone !== undefined &&
    (['date', 'time', 'partySize', 'name', 'phone'] as const).every(
      (slot) => slotStates[slot] === 'validated' || slotStates[slot] === 'confirmed',
    )
  );
}

/** Narrows the slot bag once {@link slotsComplete} has said yes. */
export function completeSlots(
  slots: Slots,
): { date: string; time: string; partySize: number; name: string; phone: string } | null {
  const { date, time, partySize, name, phone } = slots;
  if (date === undefined || time === undefined || partySize === undefined) return null;
  if (name === undefined || phone === undefined) return null;
  return { date, time, partySize, name, phone };
}

/**
 * The facts the read-back line needs.
 *
 * Only the last four digits of the phone number are spoken. The visitor already
 * knows their own number, reading all ten back costs a second of speech, and a
 * tail is enough to catch a misheard digit — which is what the read-back is for
 * (plan §4.1).
 */
export function buildReadback(state: EngineState, deps: EngineDeps): LineParams | null {
  const filled = completeSlots(state.slots);
  if (filled === null) return null;
  const today = deps.clock.now().date;

  return {
    date: filled.date,
    dateSpoken: spokenDate(filled.date, today),
    dateLong: formatDateLong(filled.date),
    time: filled.time,
    timeSpoken: spokenTime(filled.time),
    partySize: filled.partySize,
    guests: filled.partySize === 1 ? 'one guest' : `${filled.partySize} guests`,
    name: filled.name,
    phoneTail: filled.phone.slice(-4),
  };
}

/**
 * Turn a confirmed state plus an allocated table into a draft.
 *
 * The draft is what `commit_booking` is checked against. It is rebuilt from the
 * engine's own state every time rather than being carried along, so a stale one
 * cannot be committed after the visitor changed their mind.
 */
export function buildDraft(state: EngineState, tableId: string, durationMinutes: number): BookingDraft | null {
  const filled = completeSlots(state.slots);
  if (filled === null) return null;
  return { ...filled, tableId, durationMinutes };
}

/** Whether a draft still matches the slots. A change since the read-back voids it. */
export function draftMatchesSlots(draft: BookingDraft, slots: Slots): boolean {
  return (
    draft.date === slots.date &&
    draft.time === slots.time &&
    draft.partySize === slots.partySize &&
    draft.name === slots.name &&
    draft.phone === slots.phone
  );
}
