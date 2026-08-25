/**
 * The confirmation card (T-103, plan §5.3).
 *
 * The last thing a visitor sees, and the only screen whose contents someone
 * might read down a phone line to a host, so two things drive the design:
 *
 *   - **The reference is built to be read back.** Wide letter-spacing and a
 *     mono face stop `EM7K4` from looking like a word; the alphabet upstream
 *     already excludes `O/0` and `I/1`, so what is left is only a spacing
 *     problem. Sighted readers get the spaced glyphs, screen readers get the
 *     characters spelled out one at a time — the same information, delivered
 *     the way each of them can actually use it.
 *   - **Focus moves here exactly once and is handed back.** Plan §14 allows one
 *     focus move per conversation, on completion. `update()` performs it; the
 *     composition root reverses it with `restoreFocus()` when it takes the
 *     visitor somewhere else. Nothing else in the card touches focus.
 */

import { formatPhone } from '../../agent/brains/parse/phone.js';
import { formatDateLong, formatTime12 } from '../../engine/index.js';
import type { Booking } from '../../engine/index.js';
import { clear, el, moveFocusTo } from '../a11y.js';
import type { Component } from './component.js';

import '../styles/components/confirmation.css';

export interface ConfirmationProps {
  /** `null` hides the card entirely. */
  readonly booking: Booking | null;
}

export interface ConfirmationCard extends Component<ConfirmationProps> {
  /**
   * Return focus to wherever it was before the card claimed it.
   *
   * Safe to call at any time: a no-op when the card never took focus, and a
   * no-op on the second call, so the composition root can invoke it from both
   * "view the diary" and "start again" without tracking which fired.
   */
  restoreFocus(): void;
}

/** Ids have to be unique per instance; the tests build several per file. */
let instanceCount = 0;

export function createConfirmationCard(options: { onViewDiary: () => void }): ConfirmationCard {
  instanceCount += 1;
  const titleId = `confirmation-title-${String(instanceCount)}`;
  const referenceId = `confirmation-reference-${String(instanceCount)}`;

  const title = el('h2', {
    className: 'confirmation__title display',
    text: 'Your table is booked',
    attrs: { id: titleId },
  });

  const lead = el('p', {
    className: 'confirmation__lead',
    text: 'We have you down, and we look forward to having you with us.',
  });

  const summary = el('dl', { className: 'confirmation__summary' });

  const referenceLabel = el('p', {
    className: 'confirmation__reference-label eyebrow',
    attrs: { id: referenceId },
    text: 'Reference',
  });

  // The glyphs sighted readers see. Hidden from assistive technology because
  // the spelled-out sibling below says the same thing more usefully; without
  // that, a screen reader announces the code twice.
  const referenceValue = el('p', {
    className: 'confirmation__reference',
    attrs: { 'aria-hidden': 'true' },
  });

  const referenceSpoken = el('p', { className: 'visually-hidden' });

  const referenceNote = el('p', {
    className: 'confirmation__note',
    text: 'Quote this if you need to change anything.',
  });

  const cta = el('button', {
    className: 'confirmation__cta',
    text: 'View the diary',
    attrs: { type: 'button' },
  });
  cta.addEventListener('click', () => options.onViewDiary());

  const root = el('section', {
    className: 'confirmation',
    attrs: {
      'aria-labelledby': titleId,
      // Programmatically focusable without joining the tab order: focus is
      // pushed here on completion, not tabbed into.
      tabindex: '-1',
    },
    children: [
      el('p', { className: 'confirmation__eyebrow eyebrow', text: 'Confirmed' }),
      title,
      lead,
      summary,
      el('div', {
        className: 'confirmation__reference-block',
        attrs: { role: 'group', 'aria-labelledby': referenceId },
        children: [referenceLabel, referenceValue, referenceSpoken, referenceNote],
      }),
      cta,
    ],
  });
  root.hidden = true;

  let shownId: string | null = null;
  let restore: (() => void) | null = null;

  return {
    el: root,

    update(props: ConfirmationProps): void {
      const booking = props.booking;

      if (booking === null) {
        // Clear rather than merely hide. A hidden card still holds a name and a
        // phone number, and there is no reason for either to outlive the
        // booking they belong to.
        clear(summary);
        referenceValue.textContent = '';
        referenceSpoken.textContent = '';
        root.hidden = true;
        shownId = null;
        return;
      }

      if (booking.id === shownId) return;
      shownId = booking.id;

      clear(summary);
      for (const [label, value] of rowsFor(booking)) summary.append(...row(label, value));

      referenceValue.textContent = booking.reference;
      referenceSpoken.textContent = `Reference ${spell(booking.reference)}`;

      root.hidden = false;

      // The one focus move the plan permits (§14). Taken after `hidden` is
      // cleared, because focusing a hidden element does nothing.
      restore = moveFocusTo(root);
    },

    restoreFocus(): void {
      const previous = restore;
      restore = null;
      if (previous !== null) previous();
    },
  };
}

function rowsFor(booking: Booking): ReadonlyArray<readonly [string, string]> {
  return [
    ['Date', formatDateLong(booking.date)],
    ['Time', formatTime12(booking.time)],
    ['Guests', guests(booking.partySize)],
    ['Name', booking.name],
    ['Phone', formatPhone(booking.phone)],
  ];
}

function row(label: string, value: string): readonly [HTMLElement, HTMLElement] {
  return [
    el('dt', { className: 'confirmation__label', text: label }),
    el('dd', { className: 'confirmation__value', text: value }),
  ];
}

function guests(partySize: number): string {
  return partySize === 1 ? '1 guest' : `${String(partySize)} guests`;
}

/**
 * `EM7K4` announced as five separate characters.
 *
 * A screen reader hands `EM7K4` to a synthesiser that will try to pronounce it,
 * and a code you have to hear twice is a code you write down wrong. Spaces are
 * what make every engine in the chain read character by character.
 */
function spell(reference: string): string {
  return reference.split('').join(' ');
}
