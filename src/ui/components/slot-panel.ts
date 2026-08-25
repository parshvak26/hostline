/**
 * The slot panel (T-102) — five rows that fill in while the visitor talks.
 *
 * This is the demo's best visual moment (R-51), and the thing that makes it
 * work is restraint: the rows are built once and then mutated. Rebuilding them
 * on every turn would restart every transition on every update, so a row that
 * had not changed would still flicker, and the panel would read as five things
 * popping into place rather than one booking assembling itself.
 *
 * State is never carried by colour (plan §14). Each row differs in three ways
 * at once — the value's weight, its slope (italic while only *heard*, upright
 * once checked), and a word or a check mark next to it — so the panel survives
 * a greyscale screenshot, which is T-102's acceptance criterion.
 *
 * Markup is a `<dl>`: these rows are label/value pairs and nothing else, and a
 * description list is the one element that says so without ARIA. A `<ul>` would
 * need `role`s and a second element per row to reach the same meaning, and an
 * unordered list would be a lie — SLOT_ORDER is the order the agent asks in.
 */

import type { SlotName, SlotState, SlotStates, Slots } from '../../engine/index.js';
import { SLOT_ORDER, daysBetween, formatDateLong, formatTime12, isIsoDate } from '../../engine/index.js';
import { formatPhone } from '../../agent/brains/parse/phone.js';
import type { Component } from './component.js';
import { el } from '../a11y.js';
import '../styles/components/slot-panel.css';

export interface SlotPanelProps {
  readonly slots: Slots;
  readonly slotStates: SlotStates;
  /** Today, as `YYYY-MM-DD`. Only used to note "today" or "tomorrow". */
  readonly today: string;
}

export interface SlotPanelOptions {
  /**
   * Routed by the composition root to the throttled assertive region in
   * `a11y.ts`. The panel deliberately owns no `aria-live` of its own: five
   * regions announcing at once is the failure mode that region exists to stop.
   */
  readonly onAnnounce?: (text: string) => void;
}

const LABELS: Readonly<Record<SlotName, string>> = {
  date: 'Date',
  time: 'Time',
  partySize: 'Guests',
  name: 'Name',
  phone: 'Phone',
};

/** U+2014. The empty row shows a dash, not blank space, so the row still reads. */
const EM_DASH = '—';

/**
 * The marker beside each value.
 *
 * Words rather than icons for the two middle states, because "heard" and
 * "checked" are the actual distinction — the engine has independently accepted
 * a `validated` value and has not yet accepted a `proposed` one — and no glyph
 * carries that. `confirmed` earns U+2713 CHECK MARK; it is a text character,
 * not an emoji, which §5.2 forbids as UI iconography.
 */
const MARKERS: Readonly<Record<SlotState, string>> = {
  empty: '',
  proposed: 'heard',
  validated: 'checked',
  confirmed: '✓ confirmed',
};

interface Row {
  readonly root: HTMLElement;
  readonly value: HTMLElement;
  readonly marker: HTMLElement;
  readonly note: HTMLElement;
  state: SlotState;
  text: string;
}

/** Unique per document, so two panels on one page cannot collide on `id`. */
let instances = 0;

export function createSlotPanel(options: SlotPanelOptions = {}): Component<SlotPanelProps> {
  const uid = `slot-panel-${++instances}`;
  const titleId = `${uid}-title`;
  const rowsId = `${uid}-rows`;

  const title = el('h2', { className: 'slot-panel__title', text: 'Your table', attrs: { id: titleId } });

  const summary = el('span', { className: 'slot-panel__summary', text: 'Nothing yet' });
  const chevron = el('span', { className: 'slot-panel__chevron', text: '›', attrs: { 'aria-hidden': 'true' } });

  /**
   * A button and a region rather than `<details>`/`<summary>`.
   *
   * Both are keyboard-operable, but `<details>` is open or closed everywhere at
   * once, and this panel is only ever collapsible below 768px (plan §5.5).
   * Forcing a `<details>` back open at the wide breakpoint means fighting the
   * user-agent stylesheet; with a button, `aria-expanded` is the single source
   * of truth and the media query decides whether it means anything.
   */
  const toggle = el('button', {
    className: 'slot-panel__toggle',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': rowsId },
    children: [
      el('span', { className: 'visually-hidden', text: 'Booking so far' }),
      summary,
      chevron,
    ],
  });

  const onToggle = (): void => {
    toggle.setAttribute('aria-expanded', toggle.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
  };
  toggle.addEventListener('click', onToggle);

  const list = el('dl', { className: 'slot-panel__rows', attrs: { id: rowsId } });

  const rows = new Map<SlotName, Row>();
  for (const slot of SLOT_ORDER) {
    const value = el('span', { className: 'slot-panel__value slot-panel__value--empty', text: EM_DASH });
    const marker = el('span', { className: 'slot-panel__marker', text: MARKERS.empty });
    const note = el('span', { className: 'slot-panel__note', text: '' });
    const root = el('div', {
      className: 'slot-panel__row',
      attrs: { 'data-slot': slot, 'data-state': 'empty' },
      children: [
        el('dt', { className: 'slot-panel__label', text: LABELS[slot] }),
        el('dd', { className: 'slot-panel__cell', children: [value, marker, note] }),
      ],
    });
    list.append(root);
    rows.set(slot, { root, value, marker, note, state: 'empty', text: EM_DASH });
  }

  const root = el('section', {
    className: 'slot-panel',
    attrs: { 'aria-labelledby': titleId },
    children: [title, toggle, list],
  });

  return {
    el: root,

    update(props: SlotPanelProps): void {
      const filled: string[] = [];

      for (const slot of SLOT_ORDER) {
        const row = rows.get(slot);
        if (row === undefined) continue;

        const state = props.slotStates[slot];
        const text = displayValue(slot, props.slots, state);
        const wasState = row.state;
        const wasText = row.text;

        if (text !== wasText) {
          row.value.textContent = text;
          row.text = text;
        }

        if (state !== wasState) {
          row.root.setAttribute('data-state', state);
          row.marker.textContent = MARKERS[state];
          row.value.className = `slot-panel__value slot-panel__value--${state}`;
          row.state = state;
        }

        const note = slot === 'date' ? relativeNote(props.slots.date, props.today, state) : '';
        if (note !== row.note.textContent) row.note.textContent = note;

        // A genuine change only: an update that repeats the same props announces
        // nothing, or the region would repeat itself on every idle turn.
        if (state === 'confirmed' && (wasState !== 'confirmed' || wasText !== text)) {
          options.onAnnounce?.(`${LABELS[slot]} confirmed, ${text}`);
        }

        if (state !== 'empty') filled.push(text);
      }

      const line = filled.length === 0 ? 'Nothing yet' : filled.join(' · ');
      if (line !== summary.textContent) summary.textContent = line;
    },

    destroy(): void {
      toggle.removeEventListener('click', onToggle);
    },
  };
}

/** An empty slot shows the dash whatever happens to be sitting in `slots`. */
function displayValue(slot: SlotName, slots: Slots, state: SlotState): string {
  if (state === 'empty') return EM_DASH;

  switch (slot) {
    case 'date':
      return slots.date === undefined ? EM_DASH : formatDateLong(slots.date);
    case 'time':
      return slots.time === undefined ? EM_DASH : formatTime12(slots.time);
    case 'partySize':
      return slots.partySize === undefined ? EM_DASH : `${slots.partySize} ${slots.partySize === 1 ? 'guest' : 'guests'}`;
    case 'name':
      return slots.name === undefined || slots.name === '' ? EM_DASH : slots.name;
    case 'phone':
      return slots.phone === undefined ? EM_DASH : formatPhone(slots.phone);
  }
}

/**
 * "today" / "tomorrow" beside the date.
 *
 * A visitor booking tonight should not have to work out that Friday 28 August
 * is now. Anything further out gets nothing — "in four days" is arithmetic the
 * date itself already states.
 */
function relativeNote(date: string | undefined, today: string, state: SlotState): string {
  if (date === undefined || state === 'empty') return '';
  if (!isIsoDate(date) || !isIsoDate(today)) return '';
  const delta = daysBetween(today, date);
  if (delta === 0) return 'today';
  if (delta === 1) return 'tomorrow';
  return '';
}
