/**
 * Deterministic next-question selection (T-030).
 *
 * The engine, not the model, decides what still needs asking. That is what R-04
 * ("asks only for what is still missing") actually rests on: a model asked to
 * remember what it has already been told will eventually re-ask, and re-asking
 * is the fastest way for an agent to sound like a form.
 *
 * It also gives the fallback path something to say. When the model's reply does
 * not address the required question, or there is no model at all, the line
 * chosen here is the one spoken (plan §7.3, §12.7).
 *
 * Nothing here contains words. It returns a {@link PhraseKey} and the facts
 * needed to word it; `src/config/phrases.ts` owns the copy, which is what lets
 * lines be prebaked as audio at build time (T-081).
 */

import type { AgentLine, EngineState, PhraseKey, SlotName } from './types.js';
import { SLOT_ORDER } from './types.js';

/** After this many failed attempts on one slot, the question gets narrower. */
const NARROW_AFTER_ATTEMPTS = 1;

const FIRST_ASK: Readonly<Record<SlotName, PhraseKey>> = {
  date: 'ask_date',
  time: 'ask_time',
  partySize: 'ask_party',
  name: 'ask_name',
  phone: 'ask_phone',
};

const RE_ASK: Readonly<Record<SlotName, PhraseKey>> = {
  date: 'ask_date_again',
  time: 'ask_time_again',
  partySize: 'ask_party_again',
  name: 'ask_name_again',
  phone: 'ask_phone_again',
};

export interface NextQuestion {
  readonly slot: SlotName;
  readonly line: AgentLine;
}

/** A slot still needs asking unless the engine itself has accepted a value. */
export function isOutstanding(state: EngineState, slot: SlotName): boolean {
  const slotState = state.slotStates[slot];
  return slotState !== 'validated' && slotState !== 'confirmed';
}

export function outstandingSlots(state: EngineState): readonly SlotName[] {
  return SLOT_ORDER.filter((slot) => isOutstanding(state, slot));
}

/**
 * The one question the agent must ask next, or null when everything is in.
 *
 * The order is date → time → party → name → phone. Date and time first because
 * they are the two that can fail — there is no point taking someone's phone
 * number before finding out the evening is full.
 */
export function nextQuestion(state: EngineState): NextQuestion | null {
  const outstanding = outstandingSlots(state);
  const slot = outstanding[0];
  if (slot === undefined) return null;

  const attempts = state.attempts[slot] ?? 0;
  const key = attempts > NARROW_AFTER_ATTEMPTS ? RE_ASK[slot] : FIRST_ASK[slot];

  return { slot, line: { key, params: { slot, attempts } } };
}

/**
 * What to say when a turn could not be understood at all.
 *
 * Escalates rather than repeating itself: a narrower question, then an offer to
 * type, then the typed path outright (plan §4.3). Three identical re-prompts is
 * how a voice demo loses someone for good.
 */
export function recoveryLine(state: EngineState): AgentLine {
  const pending = nextQuestion(state);
  const slot = pending?.slot ?? 'date';

  if (state.consecutiveFailures >= 3) {
    return { key: 'switching_to_typing', params: { slot } };
  }
  if (state.consecutiveFailures === 2) {
    return { key: 'not_understood_offer_typing', params: { slot } };
  }
  return { key: 'not_understood', params: { slot } };
}

/** Maps an availability refusal to the line that explains it. */
export function refusalLine(reason: string, params: Record<string, string | number>): AgentLine {
  const key: PhraseKey =
    reason === 'date_in_past'
      ? 'reject_date_past'
      : reason === 'date_closed_day'
        ? 'reject_date_closed'
        : reason === 'date_closure'
          ? 'reject_date_closure'
          : reason === 'date_beyond_horizon'
            ? 'reject_date_horizon'
            : reason === 'time_outside_hours' || reason === 'time_before_lead_time'
              ? 'reject_time_hours'
              : reason === 'time_after_last_seating'
                ? 'reject_time_last_seating'
                : reason === 'party_too_large'
                  ? 'reject_party_large'
                  : reason === 'party_too_small'
                    ? 'reject_party_small'
                    : reason === 'phone_too_short' || reason === 'phone_too_long'
                      ? 'reject_phone_length'
                      : 'not_understood';

  return { key, params };
}
