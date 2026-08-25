/**
 * T-029 — confirmation policy.
 *
 * The two rules this file exists to hold up: nothing is committed without a
 * read-back the visitor answered yes to, and any slot changing after that
 * read-back voids it. Everything below is a property of one of those two.
 *
 * The affirmation is classified from the visitor's own words, so the cases that
 * matter most are the ambiguous ones — a correction is not agreement, and
 * "yeah, no" is a refusal.
 */

import { describe, expect, it } from 'vitest';

import {
  buildDraft,
  buildReadback,
  classifyAffirmation,
  completeSlots,
  draftMatchesSlots,
  isAbandonment,
  initialState,
  slotsComplete,
} from '../../src/engine/index.js';
import type { EngineState, SlotName, SlotState, Slots } from '../../src/engine/index.js';
import { FRIDAY, makeDeps } from '../helpers/engine.js';

const deps = makeDeps();

const FULL_SLOTS: Slots = {
  date: FRIDAY,
  time: '19:00',
  partySize: 4,
  name: 'Karani',
  phone: '9820011447',
};

function statesOf(value: SlotState, overrides: Partial<Record<SlotName, SlotState>> = {}) {
  return {
    date: value,
    time: value,
    partySize: value,
    name: value,
    phone: value,
    ...overrides,
  };
}

function stateWith(
  slots: Slots,
  value: SlotState = 'validated',
  overrides: Partial<Record<SlotName, SlotState>> = {},
): EngineState {
  return { ...initialState(), slots, slotStates: statesOf(value, overrides) };
}

/* --------------------------------------------------------- affirmations -- */

describe('classifyAffirmation', () => {
  const yes: readonly string[] = [
    'yes',
    'Yes please',
    'yeah',
    'yep',
    'yup',
    'sure',
    'that works',
    'sounds good',
    'go ahead',
    'book it',
    'do it',
    'perfect',
    'lovely',
    'correct',
    "that's it",
    'confirm',
    'ok',
    'okay',
    'yes, that is right',
  ];

  for (const text of yes) {
    it(`treats "${text}" as agreement`, () => {
      expect(classifyAffirmation(text)).toBe('yes');
    });
  }

  const no: readonly string[] = [
    'no',
    'nope',
    'nah',
    "that's wrong",
    'incorrect',
    'hold on',
    'hang on',
    'wait',
    'change that',
    'actually',
    "don't",
    'no thanks',
  ];

  for (const text of no) {
    it(`treats "${text}" as refusal`, () => {
      expect(classifyAffirmation(text)).toBe('no');
    });
  }

  it('classifies a correction as neither', () => {
    // The one that matters. "seven thirty" answers the read-back with a new
    // value; reading it as agreement books the wrong table.
    expect(classifyAffirmation('seven thirty')).toBe('none');
    expect(classifyAffirmation('make it five')).toBe('none');
    expect(classifyAffirmation('Friday instead')).toBe('none');
    expect(classifyAffirmation('9820011447')).toBe('none');
  });

  it('classifies silence and noise as neither', () => {
    expect(classifyAffirmation('')).toBe('none');
    expect(classifyAffirmation('   ')).toBe('none');
    expect(classifyAffirmation('??? ...')).toBe('none');
  });

  it('matches on word boundaries, so "yesterday" is not a yes', () => {
    expect(classifyAffirmation('yesterday')).toBe('none');
    expect(classifyAffirmation('we came yesterday')).toBe('none');
  });

  it('matches on word boundaries, so "notice" is not a no', () => {
    expect(classifyAffirmation('notice')).toBe('none');
    expect(classifyAffirmation('short notice')).toBe('none');
  });

  it('checks refusal before agreement', () => {
    // Both lists match these. Falling to the safe side means not booking.
    expect(classifyAffirmation('yeah, no')).toBe('no');
    expect(classifyAffirmation('no thanks')).toBe('no');
    expect(classifyAffirmation('yes — actually, wait')).toBe('no');
    expect(classifyAffirmation('sure, but change the time')).toBe('no');
  });

  it('ignores case, punctuation and curly apostrophes', () => {
    expect(classifyAffirmation('YES!')).toBe('yes');
    expect(classifyAffirmation('Don’t')).toBe('no');
    expect(classifyAffirmation('  yes.  ')).toBe('yes');
  });
});

/* ---------------------------------------------------------- abandonment -- */

describe('isAbandonment', () => {
  for (const text of ['cancel', 'never mind', 'nevermind', 'forget it', 'no thanks', 'not now', 'leave it']) {
    it(`treats "${text}" as an explicit end`, () => {
      expect(isAbandonment(text)).toBe(true);
    });
  }

  it('reads a phrase inside a longer turn', () => {
    expect(isAbandonment('actually, never mind')).toBe(true);
    expect(isAbandonment('sorry, cancel that')).toBe(true);
  });

  it('leaves an ordinary turn alone', () => {
    expect(isAbandonment('friday at seven')).toBe(false);
    expect(isAbandonment('yes please')).toBe(false);
    expect(isAbandonment('')).toBe(false);
    expect(isAbandonment('four of us')).toBe(false);
  });

  it('does not fire on a word that merely contains one', () => {
    expect(isAbandonment('what is your cancellation policy')).toBe(false);
  });
});

/* ---------------------------------------------------------- completeness -- */

describe('slotsComplete', () => {
  it('is true when all five are filled and the engine accepted each', () => {
    expect(slotsComplete(stateWith(FULL_SLOTS, 'validated'))).toBe(true);
    expect(slotsComplete(stateWith(FULL_SLOTS, 'confirmed'))).toBe(true);
  });

  it('is false when a slot has no value', () => {
    const slots: Slots = { ...FULL_SLOTS };
    delete (slots as { phone?: string }).phone;
    expect(slotsComplete(stateWith(slots, 'validated'))).toBe(false);
  });

  it('is false when a slot is only proposed', () => {
    // A brain can move a slot to `proposed` and no further. Committing on a
    // proposal would be committing on the model's say-so.
    expect(slotsComplete(stateWith(FULL_SLOTS, 'validated', { partySize: 'proposed' }))).toBe(false);
  });

  it('is false when a slot is empty despite carrying a value', () => {
    expect(slotsComplete(stateWith(FULL_SLOTS, 'validated', { time: 'empty' }))).toBe(false);
  });

  it('is false for a fresh conversation', () => {
    expect(slotsComplete(initialState())).toBe(false);
  });
});

describe('completeSlots', () => {
  it('narrows a full slot bag', () => {
    expect(completeSlots(FULL_SLOTS)).toEqual(FULL_SLOTS);
  });

  it('returns null when any slot is missing', () => {
    const fields: readonly SlotName[] = ['date', 'time', 'partySize', 'name', 'phone'];
    for (const field of fields) {
      const slots: Slots = { ...FULL_SLOTS };
      delete (slots as Record<string, unknown>)[field];
      expect(completeSlots(slots)).toBeNull();
    }
  });

  it('does not consult slot states, which is what slotsComplete is for', () => {
    expect(completeSlots(FULL_SLOTS)).not.toBeNull();
  });
});

/* ------------------------------------------------------------- read-back -- */

describe('buildReadback', () => {
  it('includes every one of the five fields', () => {
    const params = buildReadback(stateWith(FULL_SLOTS), deps);
    expect(params).not.toBeNull();
    if (params === null) return;

    expect(params['date']).toBe(FRIDAY);
    expect(params['time']).toBe('19:00');
    expect(params['partySize']).toBe(4);
    expect(params['name']).toBe('Karani');
    expect(params['phoneTail']).toBe('1447');
    expect(params['dateSpoken']).toBe('Friday the 28th');
    expect(params['timeSpoken']).toBe('7pm');
    expect(params['dateLong']).toBe('Friday 28 August');
  });

  it('reads back only the last four digits of the phone number', () => {
    // The visitor knows their own number; a tail is enough to catch a misheard
    // digit and costs a second less of speech (plan §4.1).
    const params = buildReadback(stateWith(FULL_SLOTS), deps);
    expect(params).not.toBeNull();
    if (params === null) return;

    for (const value of Object.values(params)) {
      expect(String(value)).not.toContain('9820011447');
      expect(String(value)).not.toContain('982001');
    }
  });

  it('counts guests in words the line can use directly', () => {
    const one = buildReadback(stateWith({ ...FULL_SLOTS, partySize: 1 }), deps);
    expect(one?.['guests']).toBe('one guest');
    const four = buildReadback(stateWith(FULL_SLOTS), deps);
    expect(four?.['guests']).toBe('4 guests');
  });

  it('returns null when there is nothing complete to read back', () => {
    const slots: Slots = { ...FULL_SLOTS };
    delete (slots as { name?: string }).name;
    expect(buildReadback(stateWith(slots), deps)).toBeNull();
  });
});

/* ----------------------------------------------------------------- draft -- */

describe('buildDraft and draftMatchesSlots', () => {
  it('carries the table and duration the engine allocated', () => {
    const draft = buildDraft(stateWith(FULL_SLOTS), 'T4', 105);
    expect(draft).not.toBeNull();
    if (draft === null) return;

    expect(draft).toEqual({ ...FULL_SLOTS, tableId: 'T4', durationMinutes: 105 });
  });

  it('returns null when the slots are not complete', () => {
    const slots: Slots = { ...FULL_SLOTS };
    delete (slots as { time?: string }).time;
    expect(buildDraft(stateWith(slots), 'T4', 105)).toBeNull();
  });

  it('matches the slots it was built from', () => {
    const draft = buildDraft(stateWith(FULL_SLOTS), 'T4', 105);
    if (draft === null) throw new Error('expected a draft');
    expect(draftMatchesSlots(draft, FULL_SLOTS)).toBe(true);
  });

  it('stops matching once any slot changes', () => {
    // This is rule 2 in one function: a stale draft cannot be committed after
    // the visitor changed their mind.
    const draft = buildDraft(stateWith(FULL_SLOTS), 'T4', 105);
    if (draft === null) throw new Error('expected a draft');

    expect(draftMatchesSlots(draft, { ...FULL_SLOTS, partySize: 5 })).toBe(false);
    expect(draftMatchesSlots(draft, { ...FULL_SLOTS, time: '19:15' })).toBe(false);
    expect(draftMatchesSlots(draft, { ...FULL_SLOTS, date: '2026-08-29' })).toBe(false);
    expect(draftMatchesSlots(draft, { ...FULL_SLOTS, name: 'Karani ' })).toBe(false);
    expect(draftMatchesSlots(draft, { ...FULL_SLOTS, phone: '9820011448' })).toBe(false);
  });

  it('stops matching when a slot is cleared entirely', () => {
    const draft = buildDraft(stateWith(FULL_SLOTS), 'T4', 105);
    if (draft === null) throw new Error('expected a draft');

    const cleared: Slots = { ...FULL_SLOTS };
    delete (cleared as { time?: string }).time;
    expect(draftMatchesSlots(draft, cleared)).toBe(false);
  });

  it('ignores the table and duration, which the visitor never agreed to', () => {
    // The read-back names the date, time, party, name and phone. Which table
    // the room allocates is the engine's business and can change.
    const draft = buildDraft(stateWith(FULL_SLOTS), 'T6', 999);
    if (draft === null) throw new Error('expected a draft');
    expect(draftMatchesSlots(draft, FULL_SLOTS)).toBe(true);
  });
});
