/**
 * The dialogue state machine (T-028) — a pure reducer, and the only thing in
 * this project permitted to decide that a booking exists.
 *
 * `reduce(state, event, deps)` returns a new state, a list of effects, and any
 * rejections the event produced. It never mutates, never throws, and never
 * performs I/O, so every transition in plan §10.4 can be asserted in a unit
 * test without a browser, a network, or a clock.
 *
 * ## The boundary, concretely
 *
 * A brain — either brain — talks to the engine only by emitting tool calls.
 * `commit_booking` is a *request*, and this file answers it by re-deriving
 * every precondition from its own state rather than believing anything the
 * caller said:
 *
 *   - are all five slots filled and independently validated?
 *   - is the phase actually `confirming`, meaning a read-back was offered?
 *   - did *the visitor's own words* classify as agreement? (§confirm.ts)
 *   - is the table still free, checked again, right now?
 *
 * Fail any one and the call is refused with a typed reason. A model that
 * hallucinates a confirmation gets a rejection and a re-prompt, which is what
 * `tests/unit/adversarial.test.ts` exists to prove.
 *
 * ## One convention worth knowing
 *
 * Several tool calls can arrive in a single turn, and the engine emits a `say`
 * effect for each. The orchestrator speaks **all of them, in order** — so a
 * refusal followed by its question reads as one reply. That is why the refusal
 * paths return early instead of also emitting the generic next question: two
 * `say` effects is a two-sentence reply, three is the agent talking over
 * itself.
 */

import type {
  AgentLine,
  Alternative,
  AvailabilityRequest,
  Booking,
  EngineDeps,
  EngineEvent,
  EngineResult,
  EngineState,
  Effect,
  Rejection,
  SlotName,
  SlotState,
  Slots,
} from './types.js';
import { SLOT_ORDER } from './types.js';
import { checkAvailability, findAlternatives, turnTimeFor } from './availability.js';
import { buildDraft, buildReadback, classifyAffirmation, draftMatchesSlots, isAbandonment, slotsComplete } from './confirm.js';
import { nextQuestion, recoveryLine, refusalLine } from './prompts.js';
import { preview, validateProposal } from './validate.js';
import { formatDateLong, spokenDate, spokenTime } from './time.js';

const EMPTY_SLOT_STATES: Readonly<Record<SlotName, SlotState>> = {
  date: 'empty',
  time: 'empty',
  partySize: 'empty',
  name: 'empty',
  phone: 'empty',
};

const ZERO_ATTEMPTS: Readonly<Record<SlotName, number>> = {
  date: 0,
  time: 0,
  partySize: 0,
  name: 0,
  phone: 0,
};

export function initialState(): EngineState {
  return {
    phase: 'greeting',
    slots: {},
    slotStates: EMPTY_SLOT_STATES,
    alternatives: [],
    attempts: ZERO_ATTEMPTS,
    consecutiveFailures: 0,
    readbackOffered: false,
    lastAffirmation: 'none',
    proposedThisTurn: {},
    rejections: [],
    deflectedLastTurn: false,
  };
}

/* --------------------------------------------------------------- helpers -- */

type Draft = {
  state: EngineState;
  effects: Effect[];
  rejections: Rejection[];
};

function begin(state: EngineState): Draft {
  return { state, effects: [], rejections: [] };
}

function done(draft: Draft): EngineResult {
  return { state: draft.state, effects: draft.effects, rejections: draft.rejections };
}

function reject(draft: Draft, rejection: Rejection): void {
  draft.rejections.push(rejection);
  draft.state = { ...draft.state, rejections: [...draft.state.rejections, rejection] };
}

function say(draft: Draft, line: AgentLine): void {
  draft.effects.push({ type: 'say', line });
}

function slotValue(slots: Slots, slot: SlotName): string | undefined {
  const value = slots[slot];
  return value === undefined ? undefined : String(value);
}

/** Params every line can rely on, so phrase templates never see `undefined`. */
function contextParams(state: EngineState, deps: EngineDeps): Record<string, string | number> {
  const today = deps.clock.now().date;
  const { slots } = state;
  return {
    restaurant: deps.config.name,
    date: slots.date ?? '',
    dateSpoken: slots.date === undefined ? '' : spokenDate(slots.date, today),
    dateLong: slots.date === undefined ? '' : formatDateLong(slots.date),
    time: slots.time ?? '',
    timeSpoken: slots.time === undefined ? '' : spokenTime(slots.time),
    partySize: slots.partySize ?? '',
    name: slots.name ?? '',
    phoneTail: slots.phone === undefined ? '' : slots.phone.slice(-4),
  };
}

function alternativeWords(alternatives: readonly Alternative[], today: string): string {
  const parts = alternatives.map((alt) =>
    alt.date === today || alternatives.every((a) => a.date === alternatives[0]?.date)
      ? spokenTime(alt.time)
      : `${spokenDate(alt.date, today)} at ${spokenTime(alt.time)}`,
  );
  if (parts.length <= 1) return parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  return `${parts.slice(0, -1).join(', ')} or ${last}`;
}

/**
 * Emit whatever the engine requires next: the read-back if everything is in,
 * otherwise the next outstanding question. Called at the end of any event that
 * left the conversation mid-collection.
 */
function sayNextRequirement(draft: Draft, deps: EngineDeps): void {
  const state = draft.state;
  if (state.phase === 'committed' || state.phase === 'ended') return;

  const question = nextQuestion(state);
  if (question === null) {
    // Everything is validated. Offering the read-back is the engine's own move;
    // it does not wait to be asked, so the rule brain gets there unaided.
    requestConfirmation(draft, deps);
    return;
  }

  draft.state = {
    ...state,
    attempts: { ...state.attempts, [question.slot]: (state.attempts[question.slot] ?? 0) + 1 },
  };
  say(draft, { key: question.line.key, params: { ...contextParams(draft.state, deps), ...question.line.params } });
}

/* ---------------------------------------------------------- availability -- */

/**
 * Run the availability check and fold the answer into state.
 *
 * Returns true when a table is held. On a refusal the time is cleared and
 * re-asked, because the visitor now has to choose again — leaving a known-full
 * time sitting in the slot panel would be a lie on screen.
 */
function evaluateAvailability(draft: Draft, deps: EngineDeps, request: AvailabilityRequest): boolean {
  const result = checkAvailability(request, deps);
  const today = deps.clock.now().date;

  if (result.available) {
    draft.state = { ...draft.state, alternatives: [] };
    return true;
  }

  reject(draft, result.rejection);

  const alternatives = result.alternatives;
  const base = contextParams(draft.state, deps);

  if (result.rejection.reason === 'no_availability') {
    const clearedTime: Slots = { ...draft.state.slots };
    delete (clearedTime as { time?: string }).time;

    draft.state = {
      ...draft.state,
      phase: alternatives.length > 0 ? 'offering_alternatives' : 'ended',
      slots: clearedTime,
      slotStates: { ...draft.state.slotStates, time: 'empty' },
      alternatives,
      readbackOffered: false,
      ...(alternatives.length === 0 ? { outcome: 'no_availability' as const } : {}),
    };
    delete (draft.state as { pendingConfirmation?: unknown }).pendingConfirmation;

    if (alternatives.length === 0) {
      say(draft, { key: 'no_availability_none', params: base });
      draft.effects.push({ type: 'end', outcome: 'no_availability' });
      return false;
    }

    const sameDay = alternatives.every((a) => a.date === request.date);
    say(draft, {
      key: sameDay ? 'no_availability_with_alternatives' : 'no_availability_other_day',
      params: { ...base, alternatives: alternativeWords(alternatives, today), count: alternatives.length },
    });
    return false;
  }

  // A date or time rule, rather than a full room. Clear the offending slot so
  // the next question asks for it again with the reason already spoken.
  const field = result.rejection.field;
  if (field === 'date' || field === 'time') {
    const cleared: Slots = { ...draft.state.slots };
    delete (cleared as Record<string, unknown>)[field];
    draft.state = {
      ...draft.state,
      slots: cleared,
      slotStates: { ...draft.state.slotStates, [field]: 'empty' },
      alternatives,
    };
  }

  say(draft, refusalLine(result.rejection.reason, { ...base, detail: result.rejection.detail }));
  return false;
}

/* ------------------------------------------------------------- the tools -- */

function proposeSlots(draft: Draft, deps: EngineDeps, args: unknown): void {
  const before = draft.state;
  const outcome = validateProposal(args, deps, before.slots);

  for (const rejection of outcome.rejections) reject(draft, rejection);

  if (outcome.malformed) {
    say(draft, recoveryLine(draft.state));
    sayNextRequirement(draft, deps);
    return;
  }

  // Adversarial case 14: a second proposal contradicting the first within the
  // same visitor turn. The visitor spoke once; a brain changing its mind has
  // not learned anything new, so the first answer stands.
  const accepted: Record<string, unknown> = {};
  const proposedThisTurn = { ...before.proposedThisTurn };

  for (const slot of SLOT_ORDER) {
    const value = outcome.accepted[slot];
    if (value === undefined) continue;

    const already = before.proposedThisTurn[slot];
    const asText = String(value);
    if (already !== undefined && already !== asText) {
      reject(draft, {
        reason: 'conflicting_proposal',
        field: slot,
        supplied: preview(value),
        detail: `Two different values for ${slot} in one turn ("${already}" then "${asText}").`,
      });
      continue;
    }

    accepted[slot] = value;
    proposedThisTurn[slot] = asText;
  }

  const changedSlots = SLOT_ORDER.filter(
    (slot) => accepted[slot] !== undefined && slotValue(before.slots, slot) !== String(accepted[slot]),
  );

  const slots: Slots = { ...before.slots, ...(accepted as Slots) };
  const slotStates = { ...before.slotStates };
  for (const slot of SLOT_ORDER) {
    if (accepted[slot] !== undefined) slotStates[slot] = 'validated';
  }

  // Rule 2 of the confirmation policy: any change after a read-back voids it,
  // and every confirmed slot drops back to merely validated. Skipping this is
  // how "actually, make it five" ends up booking four (R-07).
  const voidsConfirmation = changedSlots.length > 0 && before.readbackOffered;
  if (voidsConfirmation) {
    for (const slot of SLOT_ORDER) {
      if (slotStates[slot] === 'confirmed') slotStates[slot] = 'validated';
    }
  }

  // Something landed, so the conversation is making progress: the failure
  // counter and the deflection budget both reset here rather than on every
  // turn. This is the only place either of them legitimately clears.
  const accepted_something = Object.keys(accepted).length > 0;

  draft.state = {
    // Spread the *current* draft, not the `before` snapshot. `reject()` has
    // already appended to `draft.state.rejections` by this point, and rebuilding
    // from the pre-validation snapshot silently discarded every field-level
    // refusal — which is precisely the list the transcript viewer exists to
    // show (plan §10.3, T-105). The individual fields below still come from
    // `before` on purpose, because those are the pre-turn values.
    ...draft.state,
    slots,
    slotStates,
    proposedThisTurn,
    phase: voidsConfirmation ? 'collecting' : before.phase === 'greeting' ? 'collecting' : before.phase,
    readbackOffered: voidsConfirmation ? false : before.readbackOffered,
    lastAffirmation: voidsConfirmation ? 'none' : before.lastAffirmation,
    consecutiveFailures: accepted_something ? 0 : before.consecutiveFailures,
    deflectedLastTurn: accepted_something ? false : before.deflectedLastTurn,
    attempts: outcome.rejections.reduce(
      (acc, r) => (r.field === undefined ? acc : { ...acc, [r.field]: (acc[r.field] ?? 0) + 1 }),
      before.attempts,
    ),
  };
  if (voidsConfirmation) delete (draft.state as { pendingConfirmation?: unknown }).pendingConfirmation;

  for (const slot of changedSlots) {
    draft.effects.push({ type: 'announce', slot, state: 'validated' });
  }

  // R-09 / plan §4.3: a party the room cannot seat is an escalation, not a
  // retry. The rejection has already been recorded above by validateProposal.
  const oversized = outcome.rejections.find((r) => r.reason === 'party_too_large');
  if (oversized !== undefined) {
    escalate(draft, deps, 'party_too_large');
    return;
  }

  // Availability is the engine's business, not the model's. As soon as the
  // three facts that determine it are known, it is checked — unprompted.
  const { date, time, partySize } = draft.state.slots;
  if (date !== undefined && time !== undefined && partySize !== undefined) {
    // A refusal line already contains its own question ("we're full at seven,
    // I could do eight fifteen"). Stacking the generic next question on top of
    // it is how an agent ends up asking the same thing twice in one breath —
    // and announcing "let me read that back" immediately before saying the
    // table has gone is the same mistake one line earlier.
    if (!evaluateAvailability(draft, deps, { date, time, partySize })) return;
  }

  if (voidsConfirmation) {
    say(draft, { key: 'changed_needs_reconfirm', params: contextParams(draft.state, deps) });
  }

  // Say *why* a value was refused, not just "which day were you thinking?".
  //
  // A policy rejection — a past date, a closed day, a time outside the hours —
  // carries an explanation the visitor needs in order to answer better. Without
  // this the engine recorded the reason in the transcript and then re-asked the
  // same bare question, which is how an agent ends up sounding like a form that
  // will not say what it wants (plan §4.3 specifies the copy for each of these).
  const explained = outcome.rejections.find((r) => hasRefusalLine(r.reason));
  if (explained !== undefined) {
    say(
      draft,
      refusalLine(explained.reason, { ...contextParams(draft.state, deps), detail: explained.detail }),
    );
    return;
  }

  sayNextRequirement(draft, deps);
}

/** Reasons with copy of their own. Anything else falls through to a re-ask. */
function hasRefusalLine(reason: Rejection['reason']): boolean {
  return (
    reason === 'date_in_past' ||
    reason === 'date_closed_day' ||
    reason === 'date_closure' ||
    reason === 'date_beyond_horizon' ||
    reason === 'time_outside_hours' ||
    reason === 'time_before_lead_time' ||
    reason === 'time_after_last_seating' ||
    reason === 'party_too_small' ||
    reason === 'phone_too_short' ||
    reason === 'phone_too_long'
  );
}

function checkAvailabilityTool(draft: Draft, deps: EngineDeps, args: unknown): void {
  // The model's own opinion about availability is discarded entirely (§12.3).
  // Its arguments are only a hint about *what* to check; if they are unusable,
  // the engine checks what it already knows instead.
  const source = typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const outcome = validateProposal(source, deps, draft.state.slots);
  for (const rejection of outcome.rejections) reject(draft, rejection);

  const date = outcome.accepted.date ?? draft.state.slots.date;
  const time = outcome.accepted.time ?? draft.state.slots.time;
  const partySize = outcome.accepted.partySize ?? draft.state.slots.partySize;

  if (date === undefined || time === undefined || partySize === undefined) {
    reject(draft, {
      reason: 'slots_incomplete',
      supplied: preview(args),
      detail: 'Availability needs a date, a time and a party size.',
    });
    sayNextRequirement(draft, deps);
    return;
  }

  if (evaluateAvailability(draft, deps, { date, time, partySize })) sayNextRequirement(draft, deps);
}

function requestConfirmation(draft: Draft, deps: EngineDeps): void {
  const state = draft.state;

  // Already asked, and nothing has changed since. The rule brain emits
  // `request_confirmation` explicitly *and* the engine offers the read-back
  // unprompted once the last slot lands, so without this guard a single turn
  // reads the whole booking back twice.
  if (
    state.phase === 'confirming' &&
    state.pendingConfirmation !== undefined &&
    draftMatchesSlots(state.pendingConfirmation, state.slots)
  ) {
    return;
  }

  if (!slotsComplete(state)) {
    reject(draft, {
      reason: 'slots_incomplete',
      detail: 'Not every detail is in yet, so there is nothing to read back.',
    });
    sayNextRequirement(draft, deps);
    return;
  }

  const { date, time, partySize } = state.slots;
  if (date === undefined || time === undefined || partySize === undefined) return;

  // Checked again here rather than trusting the earlier pass: minutes have gone
  // by, and on a shared diary the table could have gone.
  const availability = checkAvailability({ date, time, partySize }, deps);
  if (!availability.available) {
    evaluateAvailability(draft, deps, { date, time, partySize });
    return;
  }

  const draftBooking = buildDraft(draft.state, availability.tableId, availability.durationMinutes);
  if (draftBooking === null) return;

  const params = buildReadback(draft.state, deps);
  draft.state = {
    ...draft.state,
    phase: 'confirming',
    pendingConfirmation: draftBooking,
    readbackOffered: true,
    // A fresh read-back needs a fresh answer. Carrying the previous turn's
    // "yes" forward would let a correction be committed without agreement.
    lastAffirmation: 'none',
  };

  say(draft, {
    key: state.readbackOffered ? 'readback_again' : 'readback',
    params: { ...contextParams(draft.state, deps), ...(params ?? {}) },
  });
}

function commitBooking(draft: Draft, deps: EngineDeps): void {
  const state = draft.state;

  if (state.phase === 'committed' || state.committed !== undefined) {
    reject(draft, { reason: 'already_committed', detail: 'That booking is already made.' });
    return;
  }
  if (state.phase === 'ended') {
    reject(draft, { reason: 'conversation_ended', detail: 'This conversation has already finished.' });
    return;
  }
  if (!slotsComplete(state)) {
    reject(draft, {
      reason: 'slots_incomplete',
      detail: 'A booking needs a date, a time, a party size, a name and a phone number.',
    });
    sayNextRequirement(draft, deps);
    return;
  }
  if (state.phase !== 'confirming' || state.pendingConfirmation === undefined) {
    reject(draft, {
      reason: 'not_confirming',
      detail: 'Nothing has been read back yet, so there is nothing to agree to.',
    });
    sayNextRequirement(draft, deps);
    return;
  }
  // The visitor's own words decide this, not the caller's claim about them.
  if (state.lastAffirmation !== 'yes') {
    reject(draft, {
      reason: 'confirmation_not_affirmative',
      supplied: state.lastAffirmation,
      detail: 'The visitor has not agreed to the read-back.',
    });
    sayNextRequirement(draft, deps);
    return;
  }
  if (!draftMatchesSlots(state.pendingConfirmation, state.slots)) {
    reject(draft, {
      reason: 'not_confirming',
      detail: 'A detail changed after the read-back, so it needs confirming again.',
    });
    requestConfirmation(draft, deps);
    return;
  }

  const { date, time, partySize } = state.pendingConfirmation;
  const availability = checkAvailability({ date, time, partySize }, deps);
  if (!availability.available) {
    evaluateAvailability(draft, deps, { date, time, partySize });
    return;
  }

  const now = deps.clock.now();
  const booking: Booking = {
    id: deps.ids.newId(),
    reference: deps.ids.newReference(),
    date,
    time,
    partySize,
    name: state.pendingConfirmation.name,
    phone: state.pendingConfirmation.phone,
    tableId: availability.tableId,
    durationMinutes: turnTimeFor(partySize, deps.config),
    createdAt: now.iso,
    source: deps.source,
    brain: deps.brain,
    outcome: 'booked',
    seeded: false,
  };

  const slotStates = { ...state.slotStates };
  for (const slot of SLOT_ORDER) slotStates[slot] = 'confirmed';

  draft.state = { ...state, phase: 'committed', slotStates, committed: booking, outcome: 'booked', alternatives: [] };

  for (const slot of SLOT_ORDER) draft.effects.push({ type: 'announce', slot, state: 'confirmed' });
  draft.effects.push({ type: 'commit', booking });
  say(draft, {
    key: 'booked',
    params: {
      ...contextParams(draft.state, deps),
      reference: booking.reference,
      referenceSpoken: booking.reference.split('').join(' '),
    },
  });
  draft.effects.push({ type: 'end', outcome: 'booked' });
}

function escalate(draft: Draft, deps: EngineDeps, reason: string): void {
  const params = { ...contextParams(draft.state, deps), reason };
  draft.state = { ...draft.state, phase: 'ended', outcome: 'escalate', alternatives: [] };
  delete (draft.state as { pendingConfirmation?: unknown }).pendingConfirmation;
  say(draft, { key: reason === 'party_too_large' ? 'escalate_large_party' : 'escalate_general', params });
  draft.effects.push({ type: 'end', outcome: 'escalate' });
}

/* --------------------------------------------------------------- reducer -- */

function handleToolCall(draft: Draft, deps: EngineDeps, call: { name: string; arguments: unknown }): void {
  // Once a booking exists the conversation is over as far as the engine is
  // concerned. Without this guard a late `propose_slots` demoted the confirmed
  // slots and moved the phase from `committed` back to `confirming` — a
  // transition plan §10.4 does not contain, while `state.committed` still held
  // the real booking.
  if (draft.state.phase === 'committed' || draft.state.committed !== undefined) {
    reject(draft, {
      reason: 'already_committed',
      supplied: preview(call.name),
      detail: 'That booking is already made.',
    });
    return;
  }

  if (draft.state.phase === 'ended' && call.name !== 'escalate') {
    reject(draft, {
      reason: 'conversation_ended',
      supplied: preview(call.name),
      detail: 'This conversation has already finished.',
    });
    return;
  }

  switch (call.name) {
    case 'propose_slots':
      proposeSlots(draft, deps, call.arguments);
      return;
    case 'check_availability':
      checkAvailabilityTool(draft, deps, call.arguments);
      return;
    case 'request_confirmation':
      requestConfirmation(draft, deps);
      return;
    case 'commit_booking':
      commitBooking(draft, deps);
      return;
    case 'escalate': {
      const args = call.arguments;
      const reason =
        typeof args === 'object' && args !== null && !Array.isArray(args)
          ? preview((args as Record<string, unknown>)['reason'])
          : 'unspecified';
      escalate(draft, deps, reason);
      return;
    }
    default:
      // Adversarial case 11. An unknown tool is not an error to recover from —
      // it is a proposal the engine simply does not accept.
      reject(draft, {
        reason: 'unknown_tool',
        supplied: preview(call.name),
        detail: `"${preview(call.name)}" is not a tool this engine offers.`,
      });
      sayNextRequirement(draft, deps);
  }
}

/**
 * The reducer. Pure: same inputs, same outputs, no side effects, no throws.
 */
export function reduce(state: EngineState, event: EngineEvent, deps: EngineDeps): EngineResult {
  const draft = begin(state);

  switch (event.type) {
    case 'start': {
      if (state.phase !== 'greeting') return done(draft);
      draft.state = { ...state, phase: 'collecting' };
      say(draft, { key: 'greeting', params: contextParams(draft.state, deps) });
      return done(draft);
    }

    case 'visitor_turn': {
      if (state.phase === 'committed' || state.phase === 'ended') return done(draft);

      if (isAbandonment(event.text)) {
        draft.state = { ...state, phase: 'ended', outcome: 'abandoned', proposedThisTurn: {} };
        say(draft, { key: 'abandoned', params: contextParams(draft.state, deps) });
        draft.effects.push({ type: 'end', outcome: 'abandoned' });
        return done(draft);
      }

      // A new turn resets the within-turn conflict guard and re-reads the
      // visitor's agreement from their own words.
      //
      // It deliberately does **not** reset `consecutiveFailures` or
      // `deflectedLastTurn`. Those count turns the engine could not use, and a
      // turn arriving is not evidence it was understood — resetting here made
      // the escalation ladder in §4.3 unreachable, because the counter was
      // zeroed immediately before `no_input` incremented it, so it never passed
      // one and typing was never offered. Both are cleared in `proposeSlots`
      // when something is actually accepted, which is the real signal.
      draft.state = {
        ...state,
        proposedThisTurn: {},
        lastAffirmation: classifyAffirmation(event.text),
      };
      return done(draft);
    }

    case 'tool_call':
      handleToolCall(draft, deps, event.call);
      return done(draft);

    case 'no_input': {
      if (state.phase === 'committed' || state.phase === 'ended') return done(draft);

      const failures = state.consecutiveFailures + 1;
      const pending = nextQuestion(state);
      draft.state = {
        ...state,
        consecutiveFailures: failures,
        ...(pending === null
          ? {}
          : { attempts: { ...state.attempts, [pending.slot]: (state.attempts[pending.slot] ?? 0) + 1 } }),
      };

      say(draft, {
        key: recoveryLine(draft.state).key,
        params: { ...contextParams(draft.state, deps), failures },
      });

      if (failures >= 3) draft.effects.push({ type: 'offer_typing' });
      return done(draft);
    }

    case 'off_topic': {
      if (state.phase === 'committed' || state.phase === 'ended') return done(draft);

      // One deflection, never two in a row (plan §4.3). A second one in
      // succession is treated as a turn nobody understood, which escalates
      // towards offering the typed path instead of looping politely forever.
      if (state.deflectedLastTurn) {
        return reduce({ ...state, deflectedLastTurn: false }, { type: 'no_input' }, deps);
      }

      draft.state = { ...state, deflectedLastTurn: true };
      say(draft, { key: 'deflect', params: contextParams(draft.state, deps) });
      sayNextRequirement(draft, deps);
      return done(draft);
    }

    case 'abandon': {
      if (state.phase === 'committed') return done(draft);
      draft.state = { ...state, phase: 'ended', outcome: 'abandoned' };
      say(draft, { key: 'abandoned', params: contextParams(draft.state, deps) });
      draft.effects.push({ type: 'end', outcome: 'abandoned' });
      return done(draft);
    }

    default:
      // An event the machine does not know is a no-op, not a throw (T-028).
      return done(draft);
  }
}

/** Convenience for tests and the terminal runner: fold a list of events. */
export function reduceAll(
  state: EngineState,
  events: readonly EngineEvent[],
  deps: EngineDeps,
): EngineResult {
  let current = state;
  const effects: Effect[] = [];
  const rejections: Rejection[] = [];

  for (const event of events) {
    const result = reduce(current, event, deps);
    current = result.state;
    effects.push(...result.effects);
    rejections.push(...result.rejections);
  }

  return { state: current, effects, rejections };
}

/** The alternatives the engine would offer for the current slots, if asked. */
export function currentAlternatives(state: EngineState, deps: EngineDeps): readonly Alternative[] {
  const { date, time, partySize } = state.slots;
  if (date === undefined || time === undefined || partySize === undefined) return [];
  return findAlternatives({ date, time, partySize }, deps);
}
