/**
 * The scrolling transcript (T-048, plan §5.3).
 *
 * ## Who announces
 *
 * The composition root owns a shared live region (`createLiveRegions()` in
 * `src/ui/a11y.ts`) which already speaks every turn once, politely and in
 * order. A `role="log"` region that also announced itself would read each turn
 * twice, and the second reading arrives while the agent's audio is playing —
 * the exact overlap plan §14 is written to avoid.
 *
 * So this region is `role="log"` with **`aria-live="off"`**: the role keeps it
 * navigable and correctly described, the shared region keeps the announcing.
 * `role="log"` carries an implicit polite live value in some screen readers,
 * which is why the attribute is set explicitly rather than left off.
 *
 * ## Interim text
 *
 * There is exactly one interim node and it is replaced in place, never
 * appended. Appending would grow a column of half-sentences as somebody speaks,
 * and would make the announcement question above unanswerable. When the final
 * transcript arrives the same node is promoted — reused, not swapped — so the
 * text settles from muted to full weight without moving.
 */

import type { TranscriptTurn } from '../../agent/ports.js';
import { clear, el, prefersReducedMotion } from '../a11y.js';
import type { Component } from './component.js';

export interface TranscriptProps {
  readonly turns: readonly TranscriptTurn[];
}

export interface TranscriptComponent extends Component<TranscriptProps> {
  addAgent(text: string): void;
  /** `isFinal: false` routes to `setInterim`, so callers can stay uniform. */
  addVisitor(text: string, isFinal?: boolean): void;
  /** Empty text removes the interim node. */
  setInterim(text: string): void;
}

function turnClass(role: TranscriptTurn['role']): string {
  return `transcript__turn transcript__turn--${role}`;
}

export function createTranscript(): TranscriptComponent {
  const root = el('div', {
    className: 'transcript',
    attrs: {
      role: 'log',
      'aria-live': 'off',
      'aria-label': 'Conversation transcript',
      // Scrollable regions need to be reachable by keyboard, or their content
      // is unreadable without a mouse (plan §4.8).
      tabindex: '0',
    },
  });

  let interim: HTMLElement | null = null;
  let rendered: TranscriptTurn[] = [];

  /** Newest turn into view, unless the visitor asked for less movement. */
  const follow = (): void => {
    if (prefersReducedMotion()) return;
    root.scrollTop = root.scrollHeight;
  };

  /** The interim node is always last, so finished turns go in front of it. */
  const place = (node: HTMLElement): void => {
    if (interim === null) root.append(node);
    else root.insertBefore(node, interim);
  };

  const appendTurn = (role: TranscriptTurn['role'], text: string): void => {
    place(el('p', { className: turnClass(role), text }));
    follow();
  };

  const record = (role: TranscriptTurn['role'], text: string): void => {
    rendered.push({ role, text, at: new Date().toISOString() });
  };

  const setInterim = (text: string): void => {
    if (text === '') {
      interim?.remove();
      interim = null;
      return;
    }

    if (interim === null) {
      interim = el('p', {
        className: `${turnClass('visitor')} transcript__turn--interim`,
        // Hidden from assistive technology on purpose: a partial transcript
        // that changes five times a second is noise, and the final text is
        // announced by the shared region a moment later.
        attrs: { 'aria-hidden': 'true' },
      });
      root.append(interim);
    }

    interim.textContent = text;
    follow();
  };

  return {
    el: root,

    /**
     * Props and the imperative methods write to the same list.
     *
     * When the incoming turns extend what is already on screen, only the new
     * ones are appended — rebuilding would restart the settle transition on
     * every turn and lose the scroll position. Anything else (a cleared
     * conversation, a replayed transcript) rebuilds.
     */
    update(props: TranscriptProps): void {
      const { turns } = props;
      const isExtension = turns.length >= rendered.length && rendered.every((turn, i) => turns[i] === turn);

      if (!isExtension) {
        clear(root);
        interim = null;
        rendered = [];
      }

      for (const turn of turns.slice(rendered.length)) appendTurn(turn.role, turn.text);
      rendered = [...turns];
    },

    addAgent(text: string): void {
      appendTurn('agent', text);
      record('agent', text);
    },

    addVisitor(text: string, isFinal = true): void {
      if (!isFinal) {
        setInterim(text);
        return;
      }

      if (interim !== null) {
        // Promote the node the visitor has been watching rather than replacing
        // it: same position, same line, opacity settles to full.
        interim.textContent = text;
        interim.className = turnClass('visitor');
        interim.removeAttribute('aria-hidden');
        interim = null;
        record('visitor', text);
        follow();
        return;
      }

      appendTurn('visitor', text);
      record('visitor', text);
    },

    setInterim,
  };
}
