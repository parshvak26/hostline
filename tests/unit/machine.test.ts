/**
 * T-028 — the transition matrix.
 *
 * `reduce(state, event, deps)` is the only thing in this project allowed to
 * decide that a booking exists, so every transition in plan §10.4 is asserted
 * here: the ordinary ones, the ones that end the conversation, and the two that
 * carry the safety properties — a slot change voids the read-back (R-07), and a
 * party the room cannot seat escalates rather than retries (R-09).
 *
 * The hostile cases — malformed calls, hallucinated confirmations, injection —
 * live in `tests/unit/adversarial.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { currentAlternatives, initialState, reduce, reduceAll } from '../../src/engine/index.js';
import type {
  Booking,
  Effect,
  EngineDeps,
  EngineEvent,
  EngineState,
  PhraseKey,
  SlotName,
  SlotState,
} from '../../src/engine/index.js';
import {
  CONFIG,
  FRIDAY,
  SATURDAY,
  TODAY,
  WEDNESDAY,
  call,
  fill,
  fullRoom,
  makeDeps,
  readyToConfirm,
  run,
  turn,
} from '../helpers/engine.js';

const START: EngineEvent = { type: 'start' };
const NO_INPUT: EngineEvent = { type: 'no_input' };
const OFF_TOPIC: EngineEvent = { type: 'off_topic' };
const ABANDON: EngineEvent = { type: 'abandon' };

/** The last date the horizon allows: 2026-08-25 plus sixty days, a Saturday. */
const HORIZON_SATURDAY = '2026-10-24';

const SLOTS: readonly SlotName[] = ['date', 'time', 'partySize', 'name', 'phone'];

/* --------------------------------------------------------------- helpers -- */

function sayKeys(effects: readonly Effect[]): PhraseKey[] {
  return effects.flatMap((effect) => (effect.type === 'say' ? [effect.line.key] : []));
}

function announcements(effects: readonly Effect[]): Array<{ slot: SlotName; state: SlotState }> {
  return effects.flatMap((effect) =>
    effect.type === 'announce' ? [{ slot: effect.slot, state: effect.state }] : [],
  );
}

function commits(effects: readonly Effect[]): Booking[] {
  return effects.flatMap((effect) => (effect.type === 'commit' ? [effect.booking] : []));
}

function endOutcomes(effects: readonly Effect[]): string[] {
  return effects.flatMap((effect) => (effect.type === 'end' ? [effect.outcome] : []));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** All five slots, validated, with a read-back already offered. */
function confirming(deps: EngineDeps): EngineState {
  return readyToConfirm(deps).state;
}

describe('fixture assumptions', () => {
  it('pins the calendar the cases below depend on', () => {
    expect(TODAY).toBe('2026-08-25');
    expect(CONFIG.policy.combineTables).toBe(false);
    expect(CONFIG.service.maxPartySize).toBe(8);
  });
});

/* ----------------------------------------------------------------- start -- */

describe('start', () => {
  it('moves greeting to collecting and greets', () => {
    const deps = makeDeps();
    const result = reduce(initialState(), START, deps);

    expect(result.state.phase).toBe('collecting');
    expect(sayKeys(result.effects)).toEqual(['greeting']);
    expect(result.rejections).toEqual([]);
  });

  it('names the restaurant in the greeting params', () => {
    const result = reduce(initialState(), START, makeDeps());
    const first = result.effects[0];
    expect(first?.type).toBe('say');
    if (first?.type !== 'say') return;
    expect(first.line.params['restaurant']).toBe(CONFIG.name);
  });

  it('is a no-op the second time', () => {
    const deps = makeDeps();
    const first = reduce(initialState(), START, deps);
    const second = reduce(first.state, START, deps);

    expect(second.state).toEqual(first.state);
    expect(second.effects).toEqual([]);
    expect(second.rejections).toEqual([]);
  });
});

/* ---------------------------------------------------------------- purity -- */

describe('purity', () => {
  it('never mutates the state it was given', () => {
    const deps = makeDeps();
    const before = confirming(deps);
    const snapshot = structuredClone(before);
    deepFreeze(before);

    // A representative event of every kind, each against the same frozen state.
    const events: readonly EngineEvent[] = [
      START,
      turn('yes'),
      call('propose_slots', { partySize: 6 }),
      call('request_confirmation'),
      call('commit_booking'),
      call('escalate', { reason: 'test' }),
      NO_INPUT,
      OFF_TOPIC,
      ABANDON,
    ];

    for (const event of events) {
      expect(() => reduce(before, event, deps)).not.toThrow();
      expect(before).toEqual(snapshot);
    }
  });

  it('returns deep-equal results for the same inputs twice', () => {
    const state = confirming(makeDeps());
    const event = call('propose_slots', { name: 'Mehta' });

    const first = reduce(state, event, makeDeps());
    const second = reduce(state, event, makeDeps());

    expect(second.state).toEqual(first.state);
    expect(second.effects).toEqual(first.effects);
    expect(second.rejections).toEqual(first.rejections);
  });

  it('is deterministic all the way through a booking', () => {
    // Fresh deps each time because identifiers advance a seeded counter.
    const events = [START, turn('hello'), call('propose_slots', {
      date: FRIDAY,
      time: '19:00',
      partySize: 4,
      name: 'Karani',
      phone: '9820011447',
    }), turn('yes'), call('commit_booking')];

    const first = run(events, makeDeps());
    const second = run(events, makeDeps());

    expect(second.state).toEqual(first.state);
    expect(second.effects).toEqual(first.effects);
  });
});

/* ------------------------------------------------------- unknown events -- */

describe('unknown events', () => {
  it('are no-ops rather than throws', () => {
    const deps = makeDeps();
    const state = confirming(deps);
    const bogus = { type: 'teleport', payload: 42 } as unknown as EngineEvent;

    expect(() => reduce(state, bogus, deps)).not.toThrow();

    const result = reduce(state, bogus, deps);
    expect(result.state).toBe(state);
    expect(result.effects).toEqual([]);
    expect(result.rejections).toEqual([]);
  });

  it('are no-ops even from a fresh conversation', () => {
    const fresh = initialState();
    const result = reduce(fresh, { type: '' } as unknown as EngineEvent, makeDeps());
    expect(result.state).toEqual(fresh);
  });
});

/* --------------------------------------------------------- propose_slots -- */

describe('propose_slots, one slot at a time', () => {
  it('validates each slot, announces it, and asks for the next', () => {
    const deps = makeDeps();
    const steps: ReadonlyArray<readonly [SlotName, unknown, PhraseKey]> = [
      ['date', FRIDAY, 'ask_time'],
      ['time', '19:00', 'ask_party'],
      ['partySize', 2, 'ask_name'],
      ['name', 'Karani', 'ask_phone'],
      ['phone', '9820011447', 'readback'],
    ];

    let state = run([START, turn('hello')], deps).state;
    const everySaid: PhraseKey[] = [];

    for (const [slot, value, nextKey] of steps) {
      expect(state.slotStates[slot]).toBe('empty');
      const result = reduce(state, call('propose_slots', { [slot]: value }), deps);
      state = result.state;

      expect(result.rejections).toEqual([]);
      expect(state.slotStates[slot]).toBe('validated');
      expect(announcements(result.effects)).toEqual([{ slot, state: 'validated' }]);
      expect(sayKeys(result.effects).at(-1)).toBe(nextKey);
      everySaid.push(...sayKeys(result.effects));
    }

    expect(state.phase).toBe('confirming');
    // Nothing already answered was ever asked for again.
    expect(everySaid).not.toContain('ask_date');
    expect(everySaid.filter((key) => key === 'ask_time')).toHaveLength(1);
    expect(everySaid.filter((key) => key === 'readback')).toHaveLength(1);
  });

  it('does not announce a slot re-proposed with the value it already had', () => {
    const deps = makeDeps();
    const first = run([START, turn('hello'), call('propose_slots', { date: FRIDAY })], deps);
    const again = run([turn('friday'), call('propose_slots', { date: FRIDAY })], deps, first.state);

    expect(announcements(again.effects)).toEqual([]);
    expect(again.state.slots.date).toBe(FRIDAY);
  });

  it('leaves the good slots in place when a sibling is refused', () => {
    const deps = makeDeps();
    const result = run(
      [START, turn('hello'), call('propose_slots', { date: FRIDAY, partySize: 'a table' })],
      deps,
    );

    expect(result.state.slots.date).toBe(FRIDAY);
    expect(result.state.slotStates.date).toBe('validated');
    expect(result.state.slotStates.partySize).toBe('empty');
    expect(result.rejections.map((r) => r.reason)).toEqual(['party_unparseable']);
  });

  it('returns every refusal it made on this event', () => {
    const deps = makeDeps();
    const result = run([START, turn('hello'), call('propose_slots', { name: 'x'.repeat(5000) })], deps);
    expect(result.rejections.map((r) => r.reason)).toEqual(['name_too_long']);
  });

  it('records a malformed argument object on the state, for the transcript', () => {
    const deps = makeDeps();
    const result = run([START, turn('hello'), call('propose_slots', 'friday at seven')], deps);
    expect(result.state.rejections.map((r) => r.reason)).toEqual(['malformed_arguments']);
  });

  /**
   * BUG (reported, not worked around): `proposeSlots` captures `before =
   * draft.state` and then rebuilds the state from that snapshot after calling
   * `reject()`, which had already appended to `draft.state.rejections`. Every
   * field-level refusal a proposal makes is therefore dropped from
   * `EngineState.rejections` — the list plan §10.3 surfaces in the transcript
   * as the evidence that the engine caught the AI. The per-event
   * `result.rejections` still carries them, and every other rejection path
   * (malformed arguments, unknown tool, no availability) records correctly, so
   * this is specific to the one path that matters most for the demo.
   */
  it('records a field refusal on the state, for the transcript', () => {
    const deps = makeDeps();
    const result = run([START, turn('hello'), call('propose_slots', { name: 'x'.repeat(5000) })], deps);
    expect(result.state.rejections.map((r) => r.reason)).toEqual(['name_too_long']);
  });

  it('records a within-turn contradiction on the state', () => {
    const deps = makeDeps();
    const result = run(
      [START, turn('hello'), call('propose_slots', { date: FRIDAY }), call('propose_slots', { date: SATURDAY })],
      deps,
    );
    expect(result.state.rejections.map((r) => r.reason)).toEqual(['conflicting_proposal']);
  });
});

/* ---------------------------------------------------------- availability -- */

describe('availability', () => {
  it('runs unprompted as soon as date, time and party are known', () => {
    // No check_availability call anywhere below. The engine does not wait to be
    // asked, because the model's opinion about a table is worth nothing (§12.3).
    const deps = makeDeps({ diary: fullRoom(FRIDAY, '18:30', 300) });
    const result = run(
      [
        START,
        turn('friday'),
        call('propose_slots', { date: FRIDAY }),
        turn('seven'),
        call('propose_slots', { time: '19:00' }),
        turn('four of us'),
        call('propose_slots', { partySize: 4 }),
      ],
      deps,
    );

    expect(result.rejections.map((r) => r.reason)).toEqual(['no_availability']);
    expect(result.state.phase).toBe('offering_alternatives');
    expect(
      result.effects.some((e) => e.type === 'say' && e.line.key.startsWith('no_availability')),
    ).toBe(true);
  });

  it('clears the time and offers alternatives when the room is full', () => {
    const deps = makeDeps({ diary: fullRoom(FRIDAY, '18:30', 300) });
    const result = run(
      [START, turn('hello'), call('propose_slots', { date: FRIDAY, time: '19:00', partySize: 4 })],
      deps,
    );

    expect(result.state.phase).toBe('offering_alternatives');
    // Leaving a known-full time in the slot panel would be a lie on screen.
    expect(result.state.slots.time).toBeUndefined();
    expect(result.state.slotStates.time).toBe('empty');
    expect(result.state.slots.date).toBe(FRIDAY);
    expect(result.state.slotStates.date).toBe('validated');
    expect(result.state.alternatives.length).toBeGreaterThan(0);
    expect(result.state.alternatives.length).toBeLessThanOrEqual(3);
    expect(result.state.outcome).toBeUndefined();
  });

  it('ends the conversation when there is no alternative anywhere', () => {
    // The last bookable date in the horizon, with every table occupied all day:
    // there is nowhere later to look and nothing free earlier.
    const deps = makeDeps({ diary: fullRoom(HORIZON_SATURDAY, '00:00', 1440) });
    const result = run(
      [START, turn('hello'), call('propose_slots', { date: HORIZON_SATURDAY, time: '19:00', partySize: 2 })],
      deps,
    );

    expect(result.state.alternatives).toEqual([]);
    expect(result.state.phase).toBe('ended');
    expect(result.state.outcome).toBe('no_availability');
    expect(sayKeys(result.effects)).toContain('no_availability_none');
    expect(endOutcomes(result.effects)).toEqual(['no_availability']);
    expect(commits(result.effects)).toEqual([]);
  });
});

describe('check_availability', () => {
  it('refuses when the three facts it needs are not all known', () => {
    const deps = makeDeps();
    const result = run([START, turn('hello'), call('check_availability', {})], deps);

    expect(result.rejections.map((r) => r.reason)).toEqual(['slots_incomplete']);
    expect(sayKeys(result.effects).at(-1)).toBe('ask_date');
  });

  it('treats the arguments as a hint about what to check, not as slot values', () => {
    // §12.3: the model's opinion about availability is discarded entirely, and
    // so is its attempt to fill slots through the back door.
    const deps = makeDeps({ diary: fullRoom(FRIDAY, '18:30', 300) });
    const result = run(
      [START, turn('hello'), call('check_availability', { date: FRIDAY, time: '19:00', partySize: 4 })],
      deps,
    );

    expect(result.rejections.map((r) => r.reason)).toEqual(['no_availability']);
    expect(result.state.slots).toEqual({});
    expect(result.state.alternatives.length).toBeGreaterThan(0);
  });

  it('checks what the conversation already knows when the arguments are unusable', () => {
    const deps = makeDeps();
    const collected = run(
      [START, turn('hello'), call('propose_slots', { date: FRIDAY, time: '19:00', partySize: 4 })],
      deps,
    );
    const checked = reduce(collected.state, call('check_availability', 'is seven free'), deps);

    expect(checked.rejections).toEqual([]);
    expect(checked.state.slots.time).toBe('19:00');
    expect(sayKeys(checked.effects).at(-1)).toBe('ask_name');
  });
});

describe('a day rule that only bites once the date arrives', () => {
  it('clears the time and explains the hours', () => {
    // "One o'clock" is a fine time until the visitor says Wednesday, which is
    // dinner only. The refusal carries its own question, so no second one is
    // stacked on top of it.
    const deps = makeDeps();
    const result = run(
      [
        START,
        turn('one o clock'),
        call('propose_slots', { time: '13:00' }),
        turn('wednesday, two of us'),
        call('propose_slots', { date: WEDNESDAY, partySize: 2 }),
      ],
      deps,
    );

    expect(result.rejections.map((r) => r.reason)).toEqual(['time_outside_hours']);
    expect(result.state.slots.time).toBeUndefined();
    expect(result.state.slotStates.time).toBe('empty');
    expect(result.state.slots.date).toBe(WEDNESDAY);
    expect(sayKeys(result.effects).at(-1)).toBe('reject_time_hours');
  });
});

/* ---------------------------------------------- confirmation and demotion -- */

describe('reaching the read-back', () => {
  it('offers it unprompted once the last slot lands', () => {
    const deps = makeDeps();
    const result = readyToConfirm(deps);

    expect(result.state.phase).toBe('confirming');
    expect(result.state.readbackOffered).toBe(true);
    expect(result.state.pendingConfirmation?.partySize).toBe(4);
    expect(sayKeys(result.effects).at(-1)).toBe('readback');
    // A fresh read-back needs a fresh answer, even though the visitor said
    // "yes please" earlier in the conversation.
    expect(result.state.lastAffirmation).toBe('none');
  });

  it('refuses request_confirmation while a slot is missing, and asks for it', () => {
    const deps = makeDeps();
    const result = run(
      [START, turn('hello'), call('propose_slots', { date: FRIDAY, time: '19:00' }), call('request_confirmation')],
      deps,
    );

    expect(result.rejections.map((r) => r.reason)).toContain('slots_incomplete');
    expect(result.state.phase).toBe('collecting');
    expect(result.state.pendingConfirmation).toBeUndefined();
    expect(sayKeys(result.effects).at(-1)).toBe('ask_party');
  });

  it('does not read the booking back twice in one turn', () => {
    // The rule brain emits request_confirmation explicitly and the engine also
    // offers the read-back unprompted; without the guard that is two.
    const deps = makeDeps();
    const start = readyToConfirm(deps);
    const again = run([call('request_confirmation'), call('request_confirmation')], deps, start.state);

    const readbacks = [...sayKeys(start.effects), ...sayKeys(again.effects)].filter(
      (key) => key === 'readback' || key === 'readback_again',
    );
    expect(readbacks).toEqual(['readback']);
    expect(again.effects).toEqual([]);
  });

  it('checks the table again before reading it back', () => {
    // The read-back is a promise. Making it on the strength of a check from
    // several turns ago is how a shared diary produces a double booking.
    const empty = makeDeps();
    const { pendingConfirmation: _dropped, ...rest } = confirming(empty);
    const collected: EngineState = { ...rest, phase: 'collecting', readbackOffered: false };

    const filledUp = makeDeps({ diary: fullRoom(FRIDAY, '18:30', 300) });
    const result = reduce(collected, call('request_confirmation'), filledUp);

    expect(result.rejections.map((r) => r.reason)).toEqual(['no_availability']);
    expect(result.state.pendingConfirmation).toBeUndefined();
    expect(result.state.phase).toBe('offering_alternatives');
    expect(sayKeys(result.effects)).not.toContain('readback');
  });

  it('does not read it back again on a later turn either, if nothing changed', () => {
    const deps = makeDeps();
    const start = readyToConfirm(deps);
    const later = run([turn('sorry, what was that'), call('request_confirmation')], deps, start.state);

    expect(sayKeys(later.effects)).toEqual([]);
  });
});

describe('a slot change after the read-back voids it (R-07)', () => {
  it('resets the affirmation and rebuilds the pending booking', () => {
    const deps = makeDeps();
    const changed = run(
      [turn('actually, make it five'), call('propose_slots', { partySize: 5 })],
      deps,
      confirming(deps),
    );

    expect(changed.state.slots.partySize).toBe(5);
    // The draft the visitor agreed to is gone; a new one is offered in its
    // place, with the agreement wiped so it has to be given again.
    expect(changed.state.lastAffirmation).toBe('none');
    expect(changed.state.pendingConfirmation?.partySize).toBe(5);
    expect(sayKeys(changed.effects)).toContain('changed_needs_reconfirm');
    expect(sayKeys(changed.effects).at(-1)).toBe('readback');
  });

  it('refuses a commit that rides on the previous turn\'s yes', () => {
    // "Make it five" after a yes must not book five on the strength of the yes
    // that was given for four.
    const deps = makeDeps();
    const agreed = run([turn('yes'), call('propose_slots', { partySize: 5 })], deps, confirming(deps));
    const commit = reduce(agreed.state, call('commit_booking'), deps);

    expect(commit.rejections.map((r) => r.reason)).toEqual(['confirmation_not_affirmative']);
    expect(commit.state.committed).toBeUndefined();
    expect(commits(commit.effects)).toEqual([]);
  });

  it('demotes every confirmed slot back to validated', () => {
    // Confirmed is the state slots reach once a booking is made, so this is
    // asserted against a hand-built state rather than a live conversation.
    const deps = makeDeps();
    const allConfirmed: EngineState = {
      ...confirming(deps),
      slotStates: {
        date: 'confirmed',
        time: 'confirmed',
        partySize: 'confirmed',
        name: 'confirmed',
        phone: 'confirmed',
      },
      proposedThisTurn: {},
    };

    const changed = reduce(allConfirmed, call('propose_slots', { partySize: 5 }), deps);
    for (const slot of SLOTS) expect(changed.state.slotStates[slot]).toBe('validated');
  });

  it('drops back to offering alternatives when the new party does not fit', () => {
    // Both six-tops are taken at seven, so "make it six" cannot simply be
    // re-read-back — there is nothing to confirm.
    const deps = makeDeps({ diary: fill(FRIDAY, '19:00', 'T6', 120, 2) });
    const changed = run(
      [turn('actually, six of us'), call('propose_slots', { partySize: 6 })],
      deps,
      confirming(deps),
    );

    expect(changed.state.phase).toBe('offering_alternatives');
    expect(changed.state.pendingConfirmation).toBeUndefined();
    expect(changed.state.readbackOffered).toBe(false);
    expect(changed.state.lastAffirmation).toBe('none');
    expect(changed.state.slots.time).toBeUndefined();
    expect(changed.state.slotStates.time).toBe('empty');
    expect(changed.rejections.map((r) => r.reason)).toEqual(['no_availability']);
  });

  it('holds the first answer when a brain contradicts itself inside one turn', () => {
    // The visitor spoke once. A model changing its mind has not heard anything
    // new, so the read-back is not voided at all.
    const deps = makeDeps();
    const contradicted = reduce(confirming(deps), call('propose_slots', { partySize: 5 }), deps);

    expect(contradicted.rejections.map((r) => r.reason)).toEqual(['conflicting_proposal']);
    expect(contradicted.state.slots.partySize).toBe(4);
    expect(contradicted.state.pendingConfirmation?.partySize).toBe(4);
  });
});

/* --------------------------------------------------------- commit_booking -- */

describe('commit_booking', () => {
  it('books once the visitor has agreed to the read-back', () => {
    const deps = makeDeps();
    const result = run([turn('yes'), call('commit_booking')], deps, confirming(deps));

    expect(result.state.phase).toBe('committed');
    expect(result.state.outcome).toBe('booked');
    expect(result.rejections).toEqual([]);
    for (const slot of SLOTS) expect(result.state.slotStates[slot]).toBe('confirmed');

    const booked = commits(result.effects);
    expect(booked).toHaveLength(1);
    expect(endOutcomes(result.effects)).toEqual(['booked']);
    expect(sayKeys(result.effects)).toContain('booked');

    const booking = booked[0];
    expect(booking).toBeDefined();
    if (booking === undefined) return;
    expect(booking).toEqual(result.state.committed);
    expect(booking.date).toBe(FRIDAY);
    expect(booking.time).toBe('19:00');
    expect(booking.partySize).toBe(4);
    expect(booking.name).toBe('Karani');
    expect(booking.phone).toBe('9820011447');
    expect(booking.outcome).toBe('booked');
    expect(booking.seeded).toBe(false);
    expect(booking.createdAt).toBe(deps.clock.now().iso);
    expect(booking.source).toBe('typed');
    expect(booking.brain).toBe('rule');
  });

  it('takes the table and duration from the engine, not from the call', () => {
    // A model that names a table is describing something it cannot know. Best
    // fit puts a party of four on a four-top for 105 minutes, whatever it says.
    const deps = makeDeps();
    const result = run(
      [turn('yes'), call('commit_booking', { tableId: 'T6', durationMinutes: 999, partySize: 40 })],
      deps,
      confirming(deps),
    );

    const booking = commits(result.effects)[0];
    expect(booking).toBeDefined();
    if (booking === undefined) return;
    expect(booking.tableId).toBe('T4');
    expect(booking.durationMinutes).toBe(CONFIG.turnTimeMinutes['4']);
    expect(booking.partySize).toBe(4);
  });

  it('announces every slot as confirmed, for assistive technology', () => {
    const deps = makeDeps();
    const result = run([turn('yes'), call('commit_booking')], deps, confirming(deps));

    expect(announcements(result.effects)).toEqual(
      SLOTS.map((slot) => ({ slot, state: 'confirmed' as SlotState })),
    );
  });

  it('refuses when nothing has been read back', () => {
    const deps = makeDeps();
    const result = run(
      [START, turn('yes'), call('propose_slots', { date: FRIDAY, time: '19:00' }), call('commit_booking')],
      deps,
    );

    expect(result.rejections.map((r) => r.reason)).toContain('slots_incomplete');
    expect(result.state.committed).toBeUndefined();
    expect(commits(result.effects)).toEqual([]);
  });

  it('refuses when the read-back has not been answered', () => {
    const deps = makeDeps();
    const result = reduce(confirming(deps), call('commit_booking'), deps);

    expect(result.rejections.map((r) => r.reason)).toEqual(['confirmation_not_affirmative']);
    expect(result.state.committed).toBeUndefined();
  });

  it('re-checks the table at the last moment, not just at the read-back', () => {
    // Minutes go by between the read-back and the yes. On a shared diary the
    // table can go, and the engine finds out because it asks again.
    const empty = makeDeps();
    const agreed = run([turn('yes')], empty, confirming(empty));
    const filledUp = makeDeps({ diary: fullRoom(FRIDAY, '18:30', 300) });
    const result = reduce(agreed.state, call('commit_booking'), filledUp);

    expect(result.rejections.map((r) => r.reason)).toEqual(['no_availability']);
    expect(result.state.committed).toBeUndefined();
    expect(commits(result.effects)).toEqual([]);
    expect(result.state.phase).toBe('offering_alternatives');
  });
});

describe('unknown tools', () => {
  it('are refused by name and the pending question is asked again', () => {
    const deps = makeDeps();
    const result = run([START, turn('hello'), call('cancel_booking', { id: 'anything' })], deps);

    expect(result.rejections.map((r) => r.reason)).toEqual(['unknown_tool']);
    expect(result.rejections[0]?.supplied).toBe('cancel_booking');
    expect(sayKeys(result.effects).at(-1)).toBe('ask_date');
    expect(result.state.phase).toBe('collecting');
  });
});

/* -------------------------------------------------------------- escalate -- */

describe('escalate', () => {
  it('is allowed at any point and ends the conversation', () => {
    const deps = makeDeps();
    const result = run([START, turn('hello'), call('escalate', { reason: 'a private party' })], deps);

    expect(result.state.phase).toBe('ended');
    expect(result.state.outcome).toBe('escalate');
    expect(endOutcomes(result.effects)).toEqual(['escalate']);
    expect(sayKeys(result.effects)).toContain('escalate_general');
    expect(commits(result.effects)).toEqual([]);
  });

  it('is the one tool an ended conversation still accepts', () => {
    const deps = makeDeps();
    const abandoned = run([START, turn('hello'), ABANDON], deps);
    const escalated = reduce(abandoned.state, call('escalate', { reason: 'called back' }), deps);

    expect(escalated.rejections).toEqual([]);
    expect(escalated.state.outcome).toBe('escalate');
  });

  it('refuses every other tool once the conversation has ended', () => {
    const deps = makeDeps();
    const abandoned = run([START, turn('hello'), ABANDON], deps);
    const late = reduce(abandoned.state, call('propose_slots', { partySize: 2 }), deps);

    expect(late.rejections.map((r) => r.reason)).toEqual(['conversation_ended']);
    expect(late.state.slots.partySize).toBeUndefined();
  });

  it('accepts a reason it cannot read as unspecified', () => {
    const deps = makeDeps();
    const result = run([START, turn('hello'), call('escalate', 'we need to talk to someone')], deps);

    expect(result.state.outcome).toBe('escalate');
    expect(sayKeys(result.effects)).toContain('escalate_general');
  });

  it('drops any pending confirmation on the way out', () => {
    const deps = makeDeps();
    const result = reduce(confirming(deps), call('escalate', { reason: 'group booking' }), deps);

    expect(result.state.pendingConfirmation).toBeUndefined();
    expect(result.state.alternatives).toEqual([]);
    expect(result.state.committed).toBeUndefined();
  });
});

/* ------------------------------------------------------------- abandoning -- */

describe('abandoning', () => {
  it('ends with no booking on an explicit abandon event', () => {
    const deps = makeDeps();
    const result = run([START, turn('hello'), ABANDON], deps);

    expect(result.state.phase).toBe('ended');
    expect(result.state.outcome).toBe('abandoned');
    expect(endOutcomes(result.effects)).toEqual(['abandoned']);
    expect(sayKeys(result.effects)).toContain('abandoned');
    expect(commits(result.effects)).toEqual([]);
    expect(result.state.committed).toBeUndefined();
  });

  it('ends the same way on an abandonment phrase inside a turn', () => {
    const deps = makeDeps();
    const result = run([turn('actually, never mind')], deps, confirming(deps));

    expect(result.state.phase).toBe('ended');
    expect(result.state.outcome).toBe('abandoned');
    expect(endOutcomes(result.effects)).toEqual(['abandoned']);
    expect(result.state.committed).toBeUndefined();
    expect(commits(result.effects)).toEqual([]);
  });

  it('cannot undo a booking that already exists', () => {
    const deps = makeDeps();
    const booked = run([turn('yes'), call('commit_booking')], deps, confirming(deps));
    const after = reduce(booked.state, ABANDON, deps);

    expect(after.state).toEqual(booked.state);
    expect(after.effects).toEqual([]);
  });
});

/* --------------------------------------------------------------- no_input -- */

describe('the no_input escalation ladder', () => {
  it('narrows, then offers typing, then switches to it', () => {
    const deps = makeDeps();
    let state = run([START, turn('hello')], deps).state;
    const ladder: ReadonlyArray<readonly [PhraseKey, boolean]> = [
      ['not_understood', false],
      ['not_understood_offer_typing', false],
      ['switching_to_typing', true],
    ];

    ladder.forEach(([key, offersTyping], index) => {
      const result = reduce(state, NO_INPUT, deps);
      state = result.state;

      expect(state.consecutiveFailures).toBe(index + 1);
      expect(sayKeys(result.effects)).toEqual([key]);
      expect(result.effects.some((e) => e.type === 'offer_typing')).toBe(offersTyping);
    });
  });

  it('counts a failed attempt against the slot it was waiting on', () => {
    const deps = makeDeps();
    const result = run([START, turn('hello'), NO_INPUT, NO_INPUT], deps);
    expect(result.state.attempts.date).toBe(2);
    expect(result.state.attempts.time).toBe(0);
  });

  it('resets the counter only when something is actually understood', () => {
    // A turn *arriving* is not evidence it was understood. The counter clears
    // when a proposal is accepted, not when the visitor speaks — resetting on
    // every turn is what made the escalation ladder unreachable, because the
    // counter was zeroed immediately before `no_input` incremented it.
    const deps = makeDeps();
    const stuck = run([START, turn('hello'), NO_INPUT, NO_INPUT], deps);
    expect(stuck.state.consecutiveFailures).toBe(2);

    const spokeButUnclear = reduce(stuck.state, turn('mmm'), deps);
    expect(spokeButUnclear.state.consecutiveFailures).toBe(2);

    const understood = run(
      [turn('friday please'), call('propose_slots', { date: FRIDAY })],
      deps,
      stuck.state,
    );
    expect(understood.state.consecutiveFailures).toBe(0);
  });

  it('is inert once the conversation has ended', () => {
    const deps = makeDeps();
    const ended = run([START, turn('hello'), ABANDON], deps);
    const after = reduce(ended.state, NO_INPUT, deps);

    expect(after.state).toEqual(ended.state);
    expect(after.effects).toEqual([]);
  });
});

/* -------------------------------------------------------------- off_topic -- */

describe('off_topic', () => {
  it('deflects once and returns to the pending question', () => {
    const deps = makeDeps();
    const started = run([START, turn('hello')], deps);
    const first = reduce(started.state, OFF_TOPIC, deps);

    expect(sayKeys(first.effects)).toEqual(['deflect', 'ask_date']);
    expect(first.state.deflectedLastTurn).toBe(true);
    expect(first.state.consecutiveFailures).toBe(0);
  });

  it('never deflects twice in a row (plan §4.3)', () => {
    // A second one in succession is treated as a turn nobody understood, which
    // escalates towards the typed path instead of looping politely forever.
    const deps = makeDeps();
    const started = run([START, turn('hello')], deps);
    const first = reduce(started.state, OFF_TOPIC, deps);
    const second = reduce(first.state, OFF_TOPIC, deps);

    expect(sayKeys(second.effects)).toEqual(['not_understood']);
    expect(sayKeys(second.effects)).not.toContain('deflect');
    expect(second.state.consecutiveFailures).toBe(1);
    expect(second.state.deflectedLastTurn).toBe(false);
  });

  it('renews the deflection budget once the conversation moves on', () => {
    // The budget is spent by a deflection and renewed by progress, not by the
    // mere arrival of another turn — otherwise "never two deflections in a row"
    // (§4.3) is unenforceable, since every deflection is preceded by a turn.
    const deps = makeDeps();
    const started = run([START, turn('hello')], deps);
    const first = reduce(started.state, OFF_TOPIC, deps);
    expect(first.state.deflectedLastTurn).toBe(true);

    const progressed = run(
      [turn('friday'), call('propose_slots', { date: FRIDAY })],
      deps,
      first.state,
    );
    expect(progressed.state.deflectedLastTurn).toBe(false);

    const later = reduce(progressed.state, OFF_TOPIC, deps);
    expect(sayKeys(later.effects)).toContain('deflect');
  });

  it('is inert once the conversation has ended', () => {
    const deps = makeDeps();
    const ended = run([START, turn('hello'), ABANDON], deps);
    const after = reduce(ended.state, OFF_TOPIC, deps);

    expect(after.state).toEqual(ended.state);
    expect(after.effects).toEqual([]);
  });
});

/* ----------------------------------------------------------- large party -- */

describe('a party the room cannot seat (R-09)', () => {
  it('escalates rather than re-asking', () => {
    const deps = makeDeps();
    const result = run([START, turn('hello'), call('propose_slots', { partySize: 40 })], deps);

    expect(result.rejections.map((r) => r.reason)).toEqual(['party_too_large']);
    expect(result.state.phase).toBe('ended');
    expect(result.state.outcome).toBe('escalate');
    expect(endOutcomes(result.effects)).toEqual(['escalate']);
    expect(sayKeys(result.effects)).toContain('escalate_large_party');
    expect(result.state.committed).toBeUndefined();
    expect(commits(result.effects)).toEqual([]);
  });

  it('escalates for seven, which no single table seats', () => {
    // combineTables is false, so the configured ceiling of eight is not the
    // binding constraint — the largest table is.
    const deps = makeDeps();
    const result = run([START, turn('hello'), call('propose_slots', { partySize: 7 })], deps);

    expect(result.state.outcome).toBe('escalate');
    expect(result.state.slots.partySize).toBeUndefined();
  });

  it('escalates even when the rest of the proposal was fine', () => {
    const deps = makeDeps();
    const result = run(
      [START, turn('hello'), call('propose_slots', { date: FRIDAY, time: '19:00', partySize: 40 })],
      deps,
    );

    expect(result.state.outcome).toBe('escalate');
    expect(result.state.slots.date).toBe(FRIDAY);
    expect(commits(result.effects)).toEqual([]);
  });
});

/* -------------------------------------------------------- after committing -- */

describe('after committing', () => {
  const booked = (deps: EngineDeps) => run([turn('yes'), call('commit_booking')], deps, confirming(deps));

  it('refuses a second commit', () => {
    const deps = makeDeps();
    const first = booked(deps);
    const second = reduce(first.state, call('commit_booking'), deps);

    expect(second.rejections.map((r) => r.reason)).toEqual(['already_committed']);
    expect(second.state.committed).toEqual(first.state.committed);
    expect(commits(second.effects)).toEqual([]);
  });

  it('ignores further visitor turns and silences', () => {
    const deps = makeDeps();
    const first = booked(deps);

    for (const event of [turn('and a highchair please'), NO_INPUT, OFF_TOPIC]) {
      const after = reduce(first.state, event, deps);
      expect(after.state).toEqual(first.state);
      expect(after.effects).toEqual([]);
    }
  });

  it('leaves the committed booking untouched by a later proposal', () => {
    const deps = makeDeps();
    const first = booked(deps);
    const after = reduce(first.state, call('propose_slots', { partySize: 5 }), deps);

    expect(after.state.committed).toEqual(first.state.committed);
    expect(commits(after.effects)).toEqual([]);
  });

  /**
   * BUG (reported, not worked around): `handleToolCall` guards only
   * `phase === 'ended'`, so `propose_slots` after a commit is accepted. It
   * demotes the confirmed slots and reopens the conversation at `confirming`,
   * leaving a committed booking sitting behind a live read-back. The written
   * booking is not altered, so nothing false is stored — but the transition is
   * one plan §10.4 does not have.
   */
  it('refuses a proposal once the booking exists', () => {
    const deps = makeDeps();
    const first = booked(deps);
    const after = reduce(first.state, call('propose_slots', { partySize: 5 }), deps);

    expect(after.rejections.map((r) => r.reason)).toEqual(['already_committed']);
    expect(after.state.phase).toBe('committed');
    expect(after.state.slotStates.partySize).toBe('confirmed');
  });
});

/* -------------------------------------------------------------- reduceAll -- */

describe('reduceAll', () => {
  it('folds a list exactly as repeated reduce does', () => {
    const events: readonly EngineEvent[] = [
      START,
      turn('hello'),
      call('propose_slots', { date: SATURDAY, time: '20:00' }),
      turn('two of us, Mehta'),
      call('propose_slots', { partySize: 2, name: 'Mehta' }),
      NO_INPUT,
      turn('9820011447'),
      call('propose_slots', { phone: '9820011447' }),
      turn('yes'),
      call('commit_booking'),
    ];

    const folded = reduceAll(initialState(), events, makeDeps());
    const stepped = run(events, makeDeps());

    expect(folded.state).toEqual(stepped.state);
    expect(folded.effects).toEqual(stepped.effects);
    expect(folded.rejections).toEqual(stepped.rejections);
    expect(folded.state.phase).toBe('committed');
  });

  it('folds an empty list into the state it was given', () => {
    const state = confirming(makeDeps());
    const folded = reduceAll(state, [], makeDeps());

    expect(folded.state).toBe(state);
    expect(folded.effects).toEqual([]);
    expect(folded.rejections).toEqual([]);
  });
});

describe('currentAlternatives', () => {
  it('is empty until the three facts that determine availability are known', () => {
    const deps = makeDeps();
    expect(currentAlternatives(initialState(), deps)).toEqual([]);

    const partial = run([START, turn('hello'), call('propose_slots', { date: FRIDAY })], deps);
    expect(currentAlternatives(partial.state, deps)).toEqual([]);
  });

  it('answers what the engine would offer, without changing anything', () => {
    const deps = makeDeps({ diary: fullRoom(FRIDAY, '18:30', 300) });
    const state: EngineState = {
      ...initialState(),
      slots: { date: FRIDAY, time: '19:00', partySize: 4 },
    };

    const alternatives = currentAlternatives(state, deps);
    expect(alternatives.length).toBeGreaterThan(0);
    expect(alternatives.length).toBeLessThanOrEqual(3);
    expect(state.alternatives).toEqual([]);
  });

});
