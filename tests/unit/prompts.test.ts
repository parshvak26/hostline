/**
 * T-030 — deterministic next-question selection.
 *
 * The engine, not the model, decides what still needs asking. The property that
 * matters is negative: a slot the engine has already accepted is never asked
 * for again, whatever combination of slots is filled. That is checked below by
 * enumerating all thirty-two combinations rather than by sampling a few.
 */

import { describe, expect, it } from 'vitest';

import {
  SLOT_ORDER,
  initialState,
  isOutstanding,
  nextQuestion,
  outstandingSlots,
  recoveryLine,
  refusalLine,
} from '../../src/engine/index.js';
import type { EngineState, PhraseKey, RejectionReason, SlotName, SlotState } from '../../src/engine/index.js';

function stateWith(
  filled: readonly SlotName[],
  fillState: SlotState = 'validated',
  attempts: Partial<Record<SlotName, number>> = {},
): EngineState {
  const base = initialState();
  const slotStates: Record<SlotName, SlotState> = { ...base.slotStates };
  for (const slot of filled) slotStates[slot] = fillState;

  return {
    ...base,
    slotStates,
    attempts: { ...base.attempts, ...attempts },
  };
}

/** Every subset of the five slots, as a bitmask over SLOT_ORDER. */
function everySubset(): SlotName[][] {
  const subsets: SlotName[][] = [];
  for (let mask = 0; mask < 1 << SLOT_ORDER.length; mask += 1) {
    subsets.push(SLOT_ORDER.filter((_slot, index) => (mask & (1 << index)) !== 0));
  }
  return subsets;
}

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

/* ---------------------------------------------------------- outstanding -- */

describe('isOutstanding', () => {
  it('is false only once the engine itself accepted the value', () => {
    for (const slot of SLOT_ORDER) {
      expect(isOutstanding(stateWith([slot], 'validated'), slot)).toBe(false);
      expect(isOutstanding(stateWith([slot], 'confirmed'), slot)).toBe(false);
    }
  });

  it('is true for a value a brain merely proposed', () => {
    // `proposed` is as far as a brain can move a slot. Treating it as answered
    // would let the model decide what the engine still needs to hear.
    for (const slot of SLOT_ORDER) {
      expect(isOutstanding(stateWith([slot], 'proposed'), slot)).toBe(true);
      expect(isOutstanding(stateWith([], 'empty'), slot)).toBe(true);
    }
  });
});

describe('outstandingSlots', () => {
  it('lists everything for a fresh conversation, in asking order', () => {
    expect(outstandingSlots(initialState())).toEqual(['date', 'time', 'partySize', 'name', 'phone']);
  });

  it('lists nothing once every slot is accepted', () => {
    expect(outstandingSlots(stateWith([...SLOT_ORDER]))).toEqual([]);
  });

  it('preserves asking order regardless of the order slots were filled', () => {
    expect(outstandingSlots(stateWith(['phone', 'date']))).toEqual(['time', 'partySize', 'name']);
  });

  it('agrees with isOutstanding for every combination', () => {
    for (const filled of everySubset()) {
      const state = stateWith(filled);
      const expected = SLOT_ORDER.filter((slot) => isOutstanding(state, slot));
      expect(outstandingSlots(state)).toEqual(expected);
    }
  });
});

/* --------------------------------------------------------- nextQuestion -- */

describe('nextQuestion', () => {
  it('asks for the date first', () => {
    const question = nextQuestion(initialState());
    expect(question?.slot).toBe('date');
    expect(question?.line.key).toBe('ask_date');
  });

  it('follows date → time → party → name → phone', () => {
    const asked: SlotName[] = [];
    let filled: SlotName[] = [];
    for (let step = 0; step < SLOT_ORDER.length; step += 1) {
      const question = nextQuestion(stateWith(filled));
      if (question === null) throw new Error('expected a question');
      asked.push(question.slot);
      filled = [...filled, question.slot];
    }
    expect(asked).toEqual(['date', 'time', 'partySize', 'name', 'phone']);
  });

  it('never asks for a slot the engine already accepted', () => {
    // The whole of R-04 as one property, over all thirty-two combinations and
    // both accepted states.
    for (const fillState of ['validated', 'confirmed'] as const) {
      for (const filled of everySubset()) {
        const question = nextQuestion(stateWith(filled, fillState));
        if (filled.length === SLOT_ORDER.length) {
          expect(question).toBeNull();
          continue;
        }
        if (question === null) throw new Error(`expected a question with ${filled.join(',')} filled`);
        expect(filled).not.toContain(question.slot);
      }
    }
  });

  it('always returns the first outstanding slot in asking order', () => {
    for (const filled of everySubset()) {
      const state = stateWith(filled);
      const question = nextQuestion(state);
      expect(question?.slot ?? null).toBe(outstandingSlots(state)[0] ?? null);
    }
  });

  it('returns null when everything is filled', () => {
    expect(nextQuestion(stateWith([...SLOT_ORDER], 'validated'))).toBeNull();
    expect(nextQuestion(stateWith([...SLOT_ORDER], 'confirmed'))).toBeNull();
  });

  it('still asks when a slot is only proposed', () => {
    expect(nextQuestion(stateWith([...SLOT_ORDER], 'proposed'))?.slot).toBe('date');
  });

  it('uses the first-ask phrase up to the threshold and the re-ask above it', () => {
    // A narrower question after a failure, rather than the same one again —
    // three identical re-prompts is how a voice demo loses someone.
    for (const slot of SLOT_ORDER) {
      const filled = SLOT_ORDER.filter((s) => s !== slot).filter(
        (s) => SLOT_ORDER.indexOf(s) < SLOT_ORDER.indexOf(slot),
      );
      for (const attempts of [0, 1]) {
        const question = nextQuestion(stateWith(filled, 'validated', { [slot]: attempts }));
        expect(question?.slot).toBe(slot);
        expect(question?.line.key).toBe(FIRST_ASK[slot]);
      }
      for (const attempts of [2, 5]) {
        const question = nextQuestion(stateWith(filled, 'validated', { [slot]: attempts }));
        expect(question?.line.key).toBe(RE_ASK[slot]);
      }
    }
  });

  it('carries the slot and its attempt count as line params', () => {
    const question = nextQuestion(stateWith([], 'empty', { date: 3 }));
    expect(question?.line.params).toEqual({ slot: 'date', attempts: 3 });
  });
});

/* --------------------------------------------------------- recoveryLine -- */

describe('recoveryLine', () => {
  it('escalates with consecutive failures', () => {
    const ladder: ReadonlyArray<readonly [number, PhraseKey]> = [
      [0, 'not_understood'],
      [1, 'not_understood'],
      [2, 'not_understood_offer_typing'],
      [3, 'switching_to_typing'],
      [7, 'switching_to_typing'],
    ];
    for (const [failures, key] of ladder) {
      expect(recoveryLine({ ...initialState(), consecutiveFailures: failures }).key).toBe(key);
    }
  });

  it('names the question it is recovering towards', () => {
    const state = { ...stateWith(['date', 'time']), consecutiveFailures: 1 };
    expect(recoveryLine(state).params).toEqual({ slot: 'partySize' });
  });

  it('falls back to the date when nothing is outstanding', () => {
    const state = { ...stateWith([...SLOT_ORDER]), consecutiveFailures: 2 };
    expect(recoveryLine(state).key).toBe('not_understood_offer_typing');
    expect(recoveryLine(state).params).toEqual({ slot: 'date' });
  });
});

/* ---------------------------------------------------------- refusalLine -- */

describe('refusalLine', () => {
  const mapping: ReadonlyArray<readonly [RejectionReason, PhraseKey]> = [
    ['date_in_past', 'reject_date_past'],
    ['date_closed_day', 'reject_date_closed'],
    ['date_closure', 'reject_date_closure'],
    ['date_beyond_horizon', 'reject_date_horizon'],
    ['time_outside_hours', 'reject_time_hours'],
    ['time_before_lead_time', 'reject_time_hours'],
    ['time_after_last_seating', 'reject_time_last_seating'],
    ['party_too_large', 'reject_party_large'],
    ['party_too_small', 'reject_party_small'],
    ['phone_too_short', 'reject_phone_length'],
    ['phone_too_long', 'reject_phone_length'],
  ];

  for (const [reason, key] of mapping) {
    it(`explains ${reason} with ${key}`, () => {
      expect(refusalLine(reason, {}).key).toBe(key);
    });
  }

  it('falls back to not_understood for a reason it has no line for', () => {
    const unmapped: readonly RejectionReason[] = [
      'date_unparseable',
      'time_unparseable',
      'time_not_on_slot_boundary',
      'party_unparseable',
      'name_too_long',
      'unknown_tool',
      'malformed_arguments',
      'no_availability',
      'slots_incomplete',
    ];
    for (const reason of unmapped) {
      expect(refusalLine(reason, {}).key).toBe('not_understood');
    }
    expect(refusalLine('something a future version invented', {}).key).toBe('not_understood');
  });

  it('passes its params through untouched, so the phrase can name the detail', () => {
    const params = { detail: "On Friday we're open 12:30 to 15:00", date: '2026-08-28' };
    expect(refusalLine('time_outside_hours', params).params).toEqual(params);
  });
});
