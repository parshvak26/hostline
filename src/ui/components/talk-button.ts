/**
 * The Talk button — the only control most visitors will ever use (T-048).
 *
 * Two decisions are worth writing down.
 *
 * **It adopts the server-rendered `#talk` element rather than replacing it.**
 * `index.html` ships that button inside the hero so the page is complete at
 * first contentful paint (plan §7.5 F12), and the skip-link points at `#talk`.
 * Replacing the node would break the skip-link target, drop focus if the
 * visitor had already tabbed to it, and repaint the one thing that must not
 * flicker. So the factory takes the element over: same node, same id, new
 * contents and behaviour. When no such element exists — unit tests, a second
 * instance — it builds one.
 *
 * **Every state carries a word and a shape, never a colour** (plan §5.3, §14).
 * The label changes, the accessible name changes with it, and a small mark
 * changes form: dot, ring, pulsing dot, dashed ring, square. A visitor who
 * cannot tell terracotta from ink still knows which of the five states the
 * button is in, and so does a screen reader.
 */

import type { TalkState } from '../../agent/orchestrator.js';
import { clear, el } from '../a11y.js';
import type { Component } from './component.js';
import '../styles/components/conversation.css';

export interface TalkButtonProps {
  readonly state: TalkState;
}

export interface TalkButtonOptions {
  /** Start listening. Called for every state except `speaking`. */
  onPress(): void;
  /** Barge-in. Called instead of `onPress` while the agent is speaking. */
  onInterrupt(): void;
  /** Adopt this element instead of looking for `#talk`. Tests use it. */
  element?: HTMLElement;
}

/** Visible label per state. `speaking` is the odd one: it names the action. */
const LABELS: Readonly<Record<TalkState, string>> = {
  idle: 'Talk to us',
  warming: 'Warming up…',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Tap to interrupt',
};

/**
 * Accessible names, which is what a screen-reader user has instead of the mark.
 *
 * Each begins with the visible label so the name still contains the text on
 * screen (WCAG 2.5.3), then adds the affordance the shape was carrying.
 */
const NAMES: Readonly<Record<TalkState, string>> = {
  idle: 'Talk to us',
  warming: 'Warming up… the microphone is nearly ready',
  listening: 'Listening, press to stop',
  thinking: 'Thinking, the reply is on its way',
  speaking: 'Tap to interrupt',
};

const TALK_ELEMENT_ID = 'talk';

function resolveElement(given: HTMLElement | undefined): HTMLButtonElement {
  const candidate = given ?? document.getElementById(TALK_ELEMENT_ID);

  if (candidate instanceof HTMLButtonElement) return candidate;

  const created = document.createElement('button');
  // Keep the id where the skip-link expects it, even when we had to build the
  // node ourselves.
  if (candidate === null) created.id = TALK_ELEMENT_ID;
  else candidate.replaceWith(created);
  return created;
}

export function createTalkButton(options: TalkButtonOptions): Component<TalkButtonProps> {
  const button = resolveElement(options.element);
  button.type = 'button';
  button.className = 'talk-button';

  const mark = el('span', { className: 'talk-button__mark', attrs: { 'aria-hidden': 'true' } });
  const label = el('span', { className: 'talk-button__label' });
  clear(button);
  button.append(mark, label);

  let state: TalkState = 'idle';

  const onClick = (): void => {
    // While the agent is speaking, the button is a stop button. Routing this in
    // one place means the pointer path and the keyboard path (a native button
    // fires click on Space and Enter) cannot drift apart.
    if (state === 'speaking') options.onInterrupt();
    else options.onPress();
  };

  button.addEventListener('click', onClick);

  const apply = (next: TalkState): void => {
    state = next;
    label.textContent = LABELS[next];
    button.setAttribute('aria-label', NAMES[next]);
    button.dataset['state'] = next;
  };

  apply('idle');

  return {
    el: button,

    update(props: TalkButtonProps): void {
      if (props.state !== state) apply(props.state);
    },

    destroy(): void {
      button.removeEventListener('click', onClick);
    },
  };
}
