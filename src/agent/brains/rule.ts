/**
 * The rule brain (T-031) — the conversation, with no model behind it.
 *
 * This is the half of the two-brain architecture that never fails. When the
 * free tier runs out, when the gateway is unreachable, when someone opens the
 * page in two years and nothing external answers — this runs the whole
 * conversation. It is less chatty and it asks one thing at a time, and it books
 * the table (R-31, goal §9 step 2).
 *
 * ## Shape
 *
 * Deliberately parallel to `llm.ts`: same {@link Brain} interface, same output
 * type, same route into the engine. It proposes; it does not decide. A reviewer
 * comparing the two files should see the symmetry immediately, because that
 * symmetry is the architecture made visible (plan §9).
 *
 * ## What it is and is not good at
 *
 * It is good at the things the fixture corpus contains: dates, times, party
 * sizes, names and numbers said in the ways people say them. It is not good at
 * conversation — it deflects off-topic questions once and returns to the point.
 * That is the honest trade, and the mode tag on screen says so.
 */

import type { Brain, BrainInput, BrainTurn } from '../ports.js';
import type { SlotName, ToolCall } from '../../engine/index.js';
import { classifyAffirmation, isAbandonment, nextQuestion, outstandingSlots } from '../../engine/index.js';
import type { ParseContext } from './parse/types.js';
import { parseDate } from './parse/date.js';
import { parseTime } from './parse/time.js';
import { parseParty } from './parse/party.js';
import { parseName } from './parse/name.js';
import { parsePhone } from './parse/phone.js';

/**
 * Words that mean the visitor is asking rather than answering.
 *
 * Used only to route to the engine's one-deflection path. A false positive
 * costs a deflection; a false negative costs nothing, because the parsers
 * simply find nothing and the turn is treated as unparseable.
 */
const OFF_TOPIC_MARKERS = [
  'do you have',
  'are you',
  'what is',
  "what's",
  'where is',
  "where's",
  'how much',
  'menu',
  'parking',
  'vegan',
  'vegetarian',
  'dress code',
  'wifi',
  'wi-fi',
  'dog',
  'kids menu',
  'wine list',
  'address',
  'directions',
];

/** Booking words that override an off-topic marker in the same sentence. */
const BOOKING_MARKERS = [
  'table',
  'book',
  'booking',
  'reserve',
  'reservation',
  'tonight',
  'tomorrow',
  'friday',
  'saturday',
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
];

function looksOffTopic(text: string): boolean {
  const lower = text.toLowerCase();
  if (BOOKING_MARKERS.some((m) => lower.includes(m))) return false;
  return OFF_TOPIC_MARKERS.some((m) => lower.includes(m));
}

/**
 * Explicit signals that a name is being given.
 *
 * The name parser is deliberately permissive, because it is written for the
 * moment the agent has just asked "and the name?" — at which point almost
 * anything the visitor says is the answer. Left ungated it also reads
 * "quarter past eight then" as a perfectly good surname, so it is only
 * consulted when a name is actually expected or explicitly announced.
 */
const NAME_CUES = [
  'under',
  'name is',
  "name's",
  'the name',
  'my name',
  'book it for',
  'booking for',
  'put it under',
  'it is under',
  "it's under",
  'this is',
  'surname',
  'last name',
  'first name',
];

/** Time forms that carry their own evidence, rather than being a bare number. */
const EXPLICIT_TIME = /(\b(am|pm|o'clock|noon|midday|midnight|half|quarter|past|to|ish)\b)|:|\.\d{2}|\b\d{3,4}\b/;

interface SlotMatch {
  readonly value: string | number;
  /** The span of the utterance this parser claimed. Used to arbitrate. */
  readonly matched: string;
}

/** True when `outer` strictly contains `inner` as a longer span. */
function contains(outer: string, inner: string): boolean {
  return outer.length > inner.length && outer.toLowerCase().includes(inner.toLowerCase());
}

export interface RuleBrainOptions {
  /** Restaurant config and clock, supplied by the composition root. */
  readonly context: () => ParseContext;
}

export function createRuleBrain(options: RuleBrainOptions): Brain {
  return {
    kind: 'rule',
    async respond(input: BrainInput): Promise<BrainTurn> {
      return respondSync(input, options.context());
    },
  };
}

/**
 * The brain, synchronously.
 *
 * Exported because the terminal runner, the fixture harness and the latency
 * script all want it without a promise in the way — and because a rule brain
 * that measures as "0ms plus a microtask" is easier to reason about in the
 * latency budget than one wrapped in machinery.
 */
export function respondSync(input: BrainInput, base: ParseContext): BrainTurn {
  const { text, state } = input;

  if (text.trim() === '') return { calls: [], unparseable: true };

  // Abandonment and agreement are the engine's to classify — it does so from
  // this same raw text. The brain only needs to know not to keep collecting.
  if (isAbandonment(text)) return { calls: [] };

  const ctx: ParseContext = state.slots.date === undefined ? base : { ...base, date: state.slots.date };
  const proposal = buildProposal(text, ctx, state);

  const calls: ToolCall[] = [];

  if (Object.keys(proposal).length > 0) {
    calls.push({ name: 'propose_slots', arguments: proposal });
  }

  // Everything in and the visitor has agreed: ask to commit. The engine will
  // check the preconditions again itself, and refuse if any of them has moved.
  const affirmation = classifyAffirmation(text);
  if (state.phase === 'confirming') {
    if (affirmation === 'yes' && Object.keys(proposal).length === 0) {
      calls.push({ name: 'commit_booking', arguments: {} });
      return { calls };
    }
    if (affirmation === 'no' && Object.keys(proposal).length === 0) {
      // They disagreed but did not say what is wrong. Ask the engine to read it
      // back again rather than guessing which detail they meant.
      return { calls, unparseable: true };
    }
  }

  if (calls.length === 0) {
    if (looksOffTopic(text)) return { calls: [], offTopic: true };
    // A bare "yes" while collecting is agreement to nothing in particular.
    if (affirmation !== 'none') return { calls: [] };
    return { calls: [], unparseable: true };
  }

  // Once everything the engine still wants has been supplied, ask for the
  // read-back explicitly. The engine also does this unprompted, so this is
  // belt and braces — but it keeps the rule brain's tool trace identical in
  // shape to the model's, which is what makes the two comparable.
  const remaining = outstandingSlots(state).filter((slot) => proposal[slot] === undefined);
  if (remaining.length === 0 && state.phase !== 'confirming') {
    calls.push({ name: 'request_confirmation', arguments: {} });
  }

  return { calls };
}

/**
 * Turn one utterance into a proposal, arbitrating between parsers that both
 * think they heard something.
 *
 * Each parser is asked in isolation and each one is right in isolation, which
 * is precisely the problem: "nine eight two zero zero double one four four
 * seven one" is a phone number, and it also contains the word "one", which is
 * a perfectly good party size and a perfectly good bare hour. Something has to
 * decide, and it should not be the engine — by the time a proposal reaches the
 * engine it is a claim, and the engine's job is to check claims rather than to
 * guess which of three it was meant to receive.
 *
 * Two rules settle almost everything:
 *
 *   1. **The longer claim wins.** If one parser's matched span strictly
 *      contains another's, the one that saw more context understood more. The
 *      phone number swallows the "one" inside it; "make it five" beats the bare
 *      "five" the time parser found.
 *   2. **A bare number is not a time when a party size is in play.** If the
 *      party parser found something — even an ambiguity it refused to resolve —
 *      a time with no am/pm, colon or "half past" is almost certainly the same
 *      number being counted rather than told.
 *
 * Both are heuristics and both will occasionally be wrong. When they are, the
 * cost is one extra turn, because the read-back catches it before anything is
 * written. That asymmetry is the reason to be aggressive here rather than in
 * the engine.
 */
function buildProposal(
  text: string,
  ctx: ParseContext,
  state: BrainInput['state'],
): Record<string, string | number> {
  const claims = new Map<SlotName, SlotMatch>();

  const dateResult = parseDate(text, ctx);
  if (dateResult.kind === 'ok') claims.set('date', { value: dateResult.value, matched: dateResult.matched });

  const partyResult = parseParty(text, ctx);
  if (partyResult.kind === 'ok') claims.set('partySize', { value: partyResult.value, matched: partyResult.matched });

  const phoneResult = parsePhone(text, ctx);
  if (phoneResult.kind === 'ok') claims.set('phone', { value: phoneResult.value, matched: phoneResult.matched });

  const timeResult = parseTime(text, ctx);
  if (timeResult.kind === 'ok') {
    const bare = !EXPLICIT_TIME.test(timeResult.matched);
    // Rule 2. `ambiguous` counts: the party parser saw a count it could not
    // pin down, which is still evidence the number is people, not o'clock.
    const partyInPlay = partyResult.kind === 'ok' || partyResult.kind === 'ambiguous';
    if (!(bare && partyInPlay)) {
      claims.set('time', { value: timeResult.value, matched: timeResult.matched });
    }
  }

  // The name parser is the permissive one — by design, because it is written
  // for the moment just after "and the name?", when almost anything the visitor
  // says is the answer. Away from that moment it happily reads "quarter past
  // eight then" as a surname, so it is consulted only when a name is genuinely
  // the thing being given:
  //
  //   - the visitor announced one ("it's under Karani"), or
  //   - the engine is *currently asking* for it and nothing else was heard.
  //
  // "The name slot is empty" is not enough. It is empty for most of the
  // conversation, and using it as the test meant an off-topic question asked
  // early — "do you have parking?" — was booked as the customer's name.
  const lower = text.toLowerCase();
  const nameCued = NAME_CUES.some((cue) => lower.includes(cue));
  const nameIsPending = nextQuestion(state)?.slot === 'name';
  if (nameCued || (nameIsPending && claims.size === 0 && !looksOffTopic(text))) {
    const nameResult = parseName(text, ctx);
    if (nameResult.kind === 'ok') claims.set('name', { value: nameResult.value, matched: nameResult.matched });
  }

  // Rule 1, applied last so it can drop anything the earlier steps admitted.
  //
  // A name never wins a containment contest. Its matched span is usually the
  // whole utterance, so without this exception "table for two on friday under
  // Shah" loses both the date and the party size to a name that swallowed them.
  // Names lose ties; they do not win them.
  const survivors = new Map(claims);
  for (const [slot, claim] of claims) {
    for (const [otherSlot, other] of claims) {
      if (slot === otherSlot || otherSlot === 'name') continue;
      if (contains(other.matched, claim.matched)) {
        survivors.delete(slot);
        break;
      }
    }
  }

  const proposal: Record<string, string | number> = {};
  for (const [slot, claim] of survivors) proposal[slot] = claim.value;
  return proposal;
}

/**
 * Ambiguity, reported separately.
 *
 * The parsers return `ambiguous` rather than guessing, and the orchestrator
 * uses this to ask a narrowing question ("four or five?") instead of picking
 * one. Kept out of {@link respondSync} because ambiguity is a conversational
 * move, not a proposal, and the engine has no event for it.
 */
export function ambiguities(text: string, ctx: ParseContext): Partial<Record<SlotName, readonly unknown[]>> {
  const out: Partial<Record<SlotName, readonly unknown[]>> = {};
  const date = parseDate(text, ctx);
  if (date.kind === 'ambiguous') out.date = date.candidates;
  const time = parseTime(text, ctx);
  if (time.kind === 'ambiguous') out.time = time.candidates;
  const party = parseParty(text, ctx);
  if (party.kind === 'ambiguous') out.partySize = party.candidates;
  const name = parseName(text, ctx);
  if (name.kind === 'ambiguous') out.name = name.candidates;
  return out;
}
