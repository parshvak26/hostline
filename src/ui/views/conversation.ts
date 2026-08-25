/**
 * The conversation view — transcript on one side, the booking assembling itself
 * on the other (plan §5.1).
 *
 * This is the layout, not the behaviour: it owns where the components sit and
 * how that changes at 375px, and nothing else. The orchestrator drives the
 * components through `src/main.ts`.
 *
 * It is hidden until the visitor presses the button for the first time. Showing
 * an empty transcript and five em-dashes on load would be a worse first
 * impression than the hero alone, and the hero is the whole first impression.
 */

import type { Component } from '../components/component.js';
import { el } from '../a11y.js';
import '../styles/components/conversation.css';

export interface ConversationViewParts {
  readonly transcript: HTMLElement;
  readonly listeningIndicator: HTMLElement;
  readonly slotPanel: HTMLElement;
  readonly latency: HTMLElement;
  readonly modeTag: HTMLElement;
  readonly typeInput: HTMLElement;
  readonly confirmation: HTMLElement;
}

export interface ConversationViewProps {
  readonly visible: boolean;
}

export function createConversationView(parts: ConversationViewParts): Component<ConversationViewProps> {
  const left = el('div', {
    className: 'conversation__stream',
    children: [
      el('h2', { className: 'visually-hidden', text: 'Your conversation' }),
      parts.transcript,
      parts.listeningIndicator,
      parts.typeInput,
    ],
  });

  const right = el('aside', {
    className: 'conversation__panel',
    attrs: { 'aria-label': 'Your table' },
    children: [
      parts.slotPanel,
      el('div', { className: 'conversation__meta', children: [parts.latency, parts.modeTag] }),
    ],
  });

  // `display: contents`, so the three children join the grid on the host
  // `<main id="conversation" class="conversation">` rather than sitting inside a
  // second one. Putting the grid class here as well nested it twice and halved
  // both columns; leaving it off entirely made the wrapper a single grid item
  // and stacked them. The wrapper still exists because the view needs one
  // element to show and hide, and `[hidden]` beats `display: contents`.
  const root = el('div', {
    className: 'conversation__layout',
    children: [left, right, parts.confirmation],
  });

  return {
    el: root,
    update({ visible }): void {
      // `hidden` rather than a class, so the section is genuinely removed from
      // the accessibility tree while it holds nothing worth announcing.
      root.hidden = !visible;
    },
  };
}
