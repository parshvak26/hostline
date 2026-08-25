/**
 * The latency readout (T-087, plan §5.3).
 *
 * The number is the honest part of the demo, so it is stated plainly and
 * **without a colour**: no green under a threshold, no red over it. A score
 * invites the reader to judge the machine they are on rather than read the
 * measurement, and the measurement is what plan §15 publishes.
 *
 * It stays hidden until there is something to report. A readout showing a dash,
 * or worse a zero, before the first reply reads as a broken instrument.
 */

import { el } from '../a11y.js';
import type { Component } from './component.js';

export interface LatencyProps {
  /** Milliseconds from end of speech to first audio. Zero means unmeasured. */
  readonly ms: number;
  /** Which path produced it, for example `llm` or `rule`. */
  readonly source?: string;
}

const EXPLANATION = 'Measured from the end of your sentence to the first sound of the reply.';

export function createLatencyReadout(): Component<LatencyProps> {
  const value = el('span', { className: 'latency__value mono' });
  const source = el('span', { className: 'latency__source mono' });
  const note = el('span', { className: 'latency__note small', text: EXPLANATION });

  const root = el('p', {
    className: 'latency',
    // The tooltip repeats the visible note so the meaning survives whichever
    // one the reader happens to find first.
    attrs: { title: EXPLANATION, hidden: '' },
    children: [value, source, note],
  });

  return {
    el: root,

    update(props: LatencyProps): void {
      const measured = Number.isFinite(props.ms) && props.ms > 0;
      root.hidden = !measured;
      if (!measured) return;

      value.textContent = `last reply ${Math.round(props.ms)} ms`;
      source.textContent = props.source === undefined ? '' : ` · ${props.source}`;
    },
  };
}
