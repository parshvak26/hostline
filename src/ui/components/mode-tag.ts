/**
 * The rule-mode tag (plan §5.3, R-38).
 *
 * When the day's free AI allowance is spent the host keeps working from
 * built-in rules, and the visitor is told — quietly. This is deliberately not
 * an alert, not a banner, and carries no live region: degradation should be
 * visible to anyone who looks, and invisible to anyone mid-sentence. An
 * assertive announcement would interrupt the conversation to report that the
 * conversation is still fine.
 *
 * Mode changes that genuinely need saying go through the shared status region
 * in `src/ui/a11y.ts`, which is throttled and owned by the composition root.
 */

import { el } from '../a11y.js';
import type { Component } from './component.js';

export interface ModeTagProps {
  readonly ruleMode: boolean;
  /** Overrides the default explanation, for example on a provider outage. */
  readonly reason?: string;
}

// Deliberately does not name a cause. The tag appears for several different
// reasons — no gateway configured, the day's allowance spent, the owner's kill
// switch, an unreachable worker — and asserting the wrong one is worse than
// asserting none. The caller passes a specific reason where it knows one.
const DEFAULT_REASON = 'The AI host is not available, so the built-in rules are running this conversation.';

export function createModeTag(): Component<ModeTagProps> {
  const label = el('span', { className: 'mode-tag__label', text: 'simple mode' });
  const reason = el('span', { className: 'mode-tag__reason', text: DEFAULT_REASON });

  const root = el('p', {
    className: 'mode-tag',
    attrs: { title: DEFAULT_REASON, hidden: '' },
    children: [label, reason],
  });

  return {
    el: root,

    update(props: ModeTagProps): void {
      root.hidden = !props.ruleMode;
      if (!props.ruleMode) return;

      const text = props.reason ?? DEFAULT_REASON;
      reason.textContent = text;
      root.setAttribute('title', text);
    },
  };
}
