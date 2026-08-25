// @vitest-environment jsdom
/**
 * Slot panel (T-102).
 *
 * Two claims are load-bearing here and both are asserted rather than eyeballed:
 * that every state is distinguishable with the colour removed, which is T-102's
 * acceptance criterion, and that an unchanged update touches nothing — the
 * panel's whole visual effect depends on rows persisting between turns.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SlotName, SlotState, SlotStates, Slots } from '../../src/engine/index.js';
import { SLOT_ORDER } from '../../src/engine/index.js';
import { createSlotPanel, type SlotPanelProps } from '../../src/ui/components/slot-panel.js';

const TODAY = '2026-08-25';
const EM_DASH = '—';

const ALL_EMPTY: SlotStates = {
  date: 'empty',
  time: 'empty',
  partySize: 'empty',
  name: 'empty',
  phone: 'empty',
};

function props(slots: Slots, states: Partial<Record<SlotName, SlotState>> = {}): SlotPanelProps {
  return { slots, slotStates: { ...ALL_EMPTY, ...states }, today: TODAY };
}

function rowFor(panel: { el: HTMLElement }, slot: SlotName): HTMLElement {
  const row = panel.el.querySelector(`[data-slot="${slot}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`no row rendered for ${slot}`);
  return row;
}

function child(root: Element, selector: string): HTMLElement {
  const node = root.querySelector(selector);
  if (!(node instanceof HTMLElement)) throw new Error(`no ${selector}`);
  return node;
}

const valueOf = (panel: { el: HTMLElement }, slot: SlotName): HTMLElement =>
  child(rowFor(panel, slot), '.slot-panel__value');

const markerOf = (panel: { el: HTMLElement }, slot: SlotName): HTMLElement =>
  child(rowFor(panel, slot), '.slot-panel__marker');

/* ---------------------------------------------------------- structure -- */

describe('slot panel structure', () => {
  it('renders five rows in SLOT_ORDER', () => {
    const panel = createSlotPanel();
    panel.update(props({}));

    const slots = [...panel.el.querySelectorAll('.slot-panel__row')].map((row) => row.getAttribute('data-slot'));
    expect(slots).toEqual([...SLOT_ORDER]);
  });

  it('labels each row', () => {
    const panel = createSlotPanel();
    panel.update(props({}));

    const labels = [...panel.el.querySelectorAll('.slot-panel__label')].map((node) => node.textContent);
    expect(labels).toEqual(['Date', 'Time', 'Guests', 'Name', 'Phone']);
  });

  it('has an accessible name', () => {
    const panel = createSlotPanel();
    document.body.append(panel.el);
    try {
      const id = panel.el.getAttribute('aria-labelledby');
      expect(id).not.toBeNull();
      expect(document.getElementById(id ?? '')?.textContent).toBe('Your table');
    } finally {
      panel.el.remove();
    }
  });
});

/* ------------------------------------------------------------- states -- */

describe('slot states', () => {
  it('shows an em-dash and data-state="empty" for a slot nothing has been said about', () => {
    const panel = createSlotPanel();
    panel.update(props({}));

    expect(rowFor(panel, 'time').getAttribute('data-state')).toBe('empty');
    expect(valueOf(panel, 'time').textContent).toBe(EM_DASH);
    expect(markerOf(panel, 'time').textContent).toBe('');
  });

  it('ignores a stray value while the slot is still empty', () => {
    const panel = createSlotPanel();
    panel.update(props({ time: '19:00' }, { time: 'empty' }));

    expect(valueOf(panel, 'time').textContent).toBe(EM_DASH);
  });

  it('writes the state onto the row for every state', () => {
    const states: readonly SlotState[] = ['empty', 'proposed', 'validated', 'confirmed'];
    for (const state of states) {
      const panel = createSlotPanel();
      panel.update(props({ time: '19:00' }, { time: state }));
      expect(rowFor(panel, 'time').getAttribute('data-state')).toBe(state);
    }
  });

  it('distinguishes every state without colour: the marker text differs', () => {
    const markers = (['empty', 'proposed', 'validated', 'confirmed'] as const).map((state) => {
      const panel = createSlotPanel();
      panel.update(props({ time: '19:00' }, { time: state }));
      return markerOf(panel, 'time').textContent ?? '';
    });

    expect(new Set(markers).size).toBe(4);
    expect(markers[0]).toBe('');
    expect(markers[1]).toBe('heard');
    expect(markers[3]).toContain('confirmed');
    // A text character, not an emoji — plan §5.2 forbids emoji as iconography.
    expect(markers[3]).toContain('✓');
  });

  it('distinguishes every state without colour: the value carries a per-state class', () => {
    const classes = (['empty', 'proposed', 'validated', 'confirmed'] as const).map((state) => {
      const panel = createSlotPanel();
      panel.update(props({ time: '19:00' }, { time: state }));
      return valueOf(panel, 'time').className;
    });

    expect(new Set(classes).size).toBe(4);
    // Slope is the greyscale cue: heard-but-unchecked is the only italic row.
    expect(classes[1]).toContain('slot-panel__value--proposed');
    expect(classes[2]).toContain('slot-panel__value--validated');
    expect(classes[3]).toContain('slot-panel__value--confirmed');
  });
});

/* --------------------------------------------------------- formatting -- */

describe('value formatting', () => {
  it('formats a date the long way', () => {
    const panel = createSlotPanel();
    panel.update(props({ date: '2026-08-28' }, { date: 'validated' }));
    expect(valueOf(panel, 'date').textContent).toBe('Friday 28 August');
  });

  it('formats a time in twelve-hour form', () => {
    const panel = createSlotPanel();
    panel.update(props({ time: '19:00' }, { time: 'validated' }));
    expect(valueOf(panel, 'time').textContent).toBe('7:00 pm');
  });

  it('formats a phone number in its grouped form', () => {
    const panel = createSlotPanel();
    panel.update(props({ phone: '9820011234' }, { phone: 'validated' }));
    expect(valueOf(panel, 'phone').textContent).toBe('98200 11234');
  });

  it('pluralises the party size', () => {
    const one = createSlotPanel();
    one.update(props({ partySize: 1 }, { partySize: 'validated' }));
    expect(valueOf(one, 'partySize').textContent).toBe('1 guest');

    const four = createSlotPanel();
    four.update(props({ partySize: 4 }, { partySize: 'validated' }));
    expect(valueOf(four, 'partySize').textContent).toBe('4 guests');
  });

  it('notes a date that falls today, and says nothing about a distant one', () => {
    const tonight = createSlotPanel();
    tonight.update(props({ date: TODAY }, { date: 'validated' }));
    expect(child(rowFor(tonight, 'date'), '.slot-panel__note').textContent).toBe('today');

    const later = createSlotPanel();
    later.update(props({ date: '2026-08-28' }, { date: 'validated' }));
    expect(child(rowFor(later, 'date'), '.slot-panel__note').textContent).toBe('');
  });

  it('renders a name containing markup as text', () => {
    const panel = createSlotPanel();
    const hostile = '<script>alert(1)</script>';
    panel.update(props({ name: hostile }, { name: 'validated' }));

    expect(valueOf(panel, 'name').textContent).toBe(hostile);
    expect(panel.el.querySelector('script')).toBeNull();
  });
});

/* ------------------------------------------------------------ mutation -- */

describe('updating', () => {
  it('mutates the existing rows instead of rebuilding them', () => {
    const panel = createSlotPanel();
    panel.update(props({ time: '19:00' }, { time: 'proposed' }));

    const row = rowFor(panel, 'time');
    const value = valueOf(panel, 'time');

    panel.update(props({ time: '19:00' }, { time: 'proposed' }));
    panel.update(props({ time: '19:00' }, { time: 'confirmed' }));

    // Same nodes throughout: a rebuilt row would restart every 180ms transition
    // on the panel, which is the "popping into place" T-102 exists to avoid.
    expect(rowFor(panel, 'time')).toBe(row);
    expect(valueOf(panel, 'time')).toBe(value);
    expect(value.textContent).toBe('7:00 pm');
  });

  it('summarises the booking so far in one line', () => {
    const panel = createSlotPanel();
    const summary = child(panel.el, '.slot-panel__summary');

    panel.update(props({}));
    expect(summary.textContent).toBe('Nothing yet');

    panel.update(props({ date: '2026-08-28', partySize: 4 }, { date: 'validated', partySize: 'confirmed' }));
    expect(summary.textContent).toBe('Friday 28 August · 4 guests');
  });
});

/* -------------------------------------------------------- announcements -- */

describe('announcements', () => {
  it('announces a slot that reaches confirmed, with its name and value', () => {
    const onAnnounce = vi.fn();
    const panel = createSlotPanel({ onAnnounce });

    panel.update(props({ time: '19:00' }, { time: 'validated' }));
    panel.update(props({ time: '19:00' }, { time: 'confirmed' }));

    expect(onAnnounce).toHaveBeenCalledTimes(1);
    expect(onAnnounce).toHaveBeenCalledWith('Time confirmed, 7:00 pm');
  });

  it('says nothing when a slot only reaches validated', () => {
    const onAnnounce = vi.fn();
    const panel = createSlotPanel({ onAnnounce });

    panel.update(props({ time: '19:00' }, { time: 'proposed' }));
    panel.update(props({ time: '19:00' }, { time: 'validated' }));

    expect(onAnnounce).not.toHaveBeenCalled();
  });

  it('says nothing on an update that changes nothing', () => {
    const onAnnounce = vi.fn();
    const panel = createSlotPanel({ onAnnounce });
    const confirmed = props({ time: '19:00' }, { time: 'confirmed' });

    panel.update(confirmed);
    onAnnounce.mockClear();
    panel.update(confirmed);
    panel.update({ ...confirmed });

    expect(onAnnounce).not.toHaveBeenCalled();
  });

  it('announces again when a confirmed value is corrected', () => {
    const onAnnounce = vi.fn();
    const panel = createSlotPanel({ onAnnounce });

    panel.update(props({ time: '19:00' }, { time: 'confirmed' }));
    panel.update(props({ time: '19:30' }, { time: 'confirmed' }));

    expect(onAnnounce).toHaveBeenLastCalledWith('Time confirmed, 7:30 pm');
    expect(onAnnounce).toHaveBeenCalledTimes(2);
  });

  it('works without an onAnnounce callback', () => {
    const panel = createSlotPanel();
    expect(() => panel.update(props({ name: 'Ada' }, { name: 'confirmed' }))).not.toThrow();
  });
});

/* ------------------------------------------------------ mobile collapse -- */

describe('mobile collapse', () => {
  it('exposes a keyboard-operable toggle that controls the rows', () => {
    const panel = createSlotPanel();
    panel.update(props({}));

    const toggle = child(panel.el, '.slot-panel__toggle');
    const rows = child(panel.el, '.slot-panel__rows');

    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-controls')).toBe(rows.id);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('stops toggling once destroyed', () => {
    const panel = createSlotPanel();
    panel.update(props({}));
    const toggle = child(panel.el, '.slot-panel__toggle');

    panel.destroy?.();
    toggle.click();

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});
