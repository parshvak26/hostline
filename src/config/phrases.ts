/**
 * Every fixed line the agent can say (T-080).
 *
 * The engine decides *what* must be said and returns a {@link PhraseKey}; this
 * file decides *how it is worded*. Two reasons for the split, both practical:
 *
 *   - **Audio can be baked at build time.** A key with no placeholders is a
 *     clip that can be synthesised once, committed, and played with zero
 *     synthesis latency at runtime. That is the mechanism R-20's sub-second
 *     target actually rests on (plan §12.5), and it is why `bakeablePhrases()`
 *     exists further down.
 *   - **Copy can change without touching tested code.** Rewording the greeting
 *     should not require re-reading `machine.ts`.
 *
 * ## The voice (plan §5.4, binding)
 *
 * Warm, brief, competent. Never apologetic, never chirpy, no exclamation marks,
 * never a reference to being a model. **At most two sentences per line** — that
 * is a latency rule as much as a style one, because the first sentence is what
 * reaches audio first and a short one reaches it sooner.
 *
 * Variants exist so the agent does not repeat itself word for word across a
 * conversation. Only the first variant of each key is baked; the others fall
 * through to hosted or browser speech, which is the right trade — variety
 * matters least on the lines that repeat least.
 */

import type { LineParams, PhraseKey } from '../engine/types.js';

/**
 * Ordered by frequency of use within a conversation, because the first variant
 * of each key is the one that gets baked and therefore the one that has to be
 * right.
 */
export const PHRASES: Readonly<Record<PhraseKey, readonly string[]>> = {
  greeting: ['Ember and Oak. What can I put in the diary for you?'],
  greeting_returning: ['Ember and Oak, welcome back. What are we booking?'],

  ask_date: ['Which day were you thinking?', 'What day suits you?'],
  ask_time: ['And what time?', 'What time were you thinking?'],
  ask_party: ['How many of you?', 'And how many will there be?'],
  ask_name: ['What name should I put it under?', 'And the name?'],
  ask_phone: ['Last thing, a phone number.', 'And a number to reach you on.'],

  // Narrower second attempts. A re-prompt that repeats itself word for word is
  // what makes people give up on voice interfaces (plan §4.3).
  ask_date_again: ['Which day — today, tomorrow, or a date?'],
  ask_time_again: ['What time — say it like half seven, or nineteen thirty.'],
  ask_party_again: ['How many people, as a number between one and eight?'],
  ask_name_again: ['Just the surname is fine.'],
  ask_phone_again: ['The digits on their own is fine.'],

  readback: [
    '{dateSpoken} at {timeSpoken}, {guests}, under {name}, ending {phoneTail}. Shall I book that?',
  ],
  readback_again: ['So that is {dateSpoken} at {timeSpoken}, {guests}, under {name}. Book it?'],

  booked: ['Booked. Your reference is {referenceSpoken}.'],

  reject_date_past: ['{dateLong} has gone by. Which day did you mean?'],
  reject_date_closed: ['We are closed that day. Would another day work?'],
  reject_date_closure: ['We are shut that day. Shall we find another?'],
  reject_date_horizon: ['That is further ahead than we take bookings. Something sooner?'],
  reject_time_hours: ['{detail} What time inside that works?'],
  reject_time_last_seating: ['{detail} Would a little earlier suit?'],
  reject_party_large: ['{detail} For a group that size we would want to speak with you directly.'],
  reject_party_small: ['{detail} How many will there be?'],
  reject_phone_length: ['{detail} Could you give me the number again?'],

  no_availability_with_alternatives: [
    'We are full at {timeSpoken}. I could do {alternatives}.',
    '{timeSpoken} has gone. I have {alternatives}.',
  ],
  no_availability_other_day: ['Nothing left that day. I could do {alternatives}.'],
  no_availability_none: ['We have nothing near that, I am afraid. Try us another week.'],

  escalate_large_party: ['For a group that size we would want to speak with you directly.'],
  escalate_general: ['I will pass this to someone who can help properly.'],

  // Ambiguity is a question, not a failure. The parsers return candidates
  // rather than guessing, and this is what the agent does with them (R-03:
  // "four of us, maybe five" has to work).
  ask_disambiguate: ['{options}?', 'Which is it, {options}?'],

  not_understood: ['Sorry, say that again?', 'I did not catch that.'],
  not_understood_offer_typing: ['Still not catching it. You can type instead if that is easier.'],
  switching_to_typing: ['Let us switch to typing.'],

  still_there: ['Still there?'],
  deflect: ['I only handle the bookings, I am afraid.'],
  abandoned: ['No problem. We are here when you need us.'],

  // Fillers. These exist purely so there is never dead air at 400ms (R-23), so
  // they are short, prebaked, and deliberately content-free.
  filler_checking: ['Let me check.', 'One moment.'],
  filler_moment: ['Bear with me.'],

  changed_needs_reconfirm: ['Right, let me read that back again.'],
};

const PLACEHOLDER = /\{(\w+)\}/g;

/** True when a variant contains no placeholders, and can therefore be baked. */
export function isBakeable(text: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return !PLACEHOLDER.test(text);
}

export interface BakedPhrase {
  readonly key: PhraseKey;
  readonly variant: number;
  readonly text: string;
  /** Filename stem used in `public/audio/`. */
  readonly id: string;
}

/**
 * Every line that can be synthesised ahead of time.
 *
 * `scripts/bake-audio.ts` writes one Opus clip per entry, and a CI check
 * asserts that the manifest still covers all of them — which is what stops the
 * copy and the audio drifting apart (T-081's stated failure point).
 */
export function bakeablePhrases(): BakedPhrase[] {
  const out: BakedPhrase[] = [];
  for (const [key, variants] of Object.entries(PHRASES) as [PhraseKey, readonly string[]][]) {
    variants.forEach((text, variant) => {
      if (isBakeable(text)) out.push({ key, variant, text, id: `${key}.${variant}` });
    });
  }
  return out;
}

/**
 * Pick a variant deterministically.
 *
 * Seeded rather than random so that a fixture conversation replays identically
 * — the latency measurements and the e2e transcripts both depend on it.
 */
export function variantFor(key: PhraseKey, seed: number): number {
  const variants = PHRASES[key];
  if (variants.length <= 1) return 0;
  const index = Math.abs(Math.trunc(seed)) % variants.length;
  return index;
}

/**
 * Render a line.
 *
 * A missing parameter renders as an empty string and the surrounding whitespace
 * is tidied, rather than leaving `{name}` visible. The agent saying nothing
 * about a detail is recoverable; the agent saying "under {name}" out loud is
 * the single most demo-destroying bug available here.
 */
export function renderPhrase(key: PhraseKey, params: LineParams = {}, seed = 0): string {
  const variants = PHRASES[key];
  const text = variants[variantFor(key, seed)] ?? variants[0] ?? '';

  return text
    .replace(PLACEHOLDER, (_match, name: string) => {
      const value = params[name];
      return value === undefined ? '' : String(value);
    })
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,?])/g, '$1')
    .replace(/([.,?])\1+/g, '$1')
    .trim();
}

/** Every key, for the coverage check in `scripts/check-phrase-coverage.mjs`. */
export function allPhraseKeys(): PhraseKey[] {
  return Object.keys(PHRASES) as PhraseKey[];
}
