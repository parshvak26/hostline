/**
 * The listening indicator (T-101) — a pen trace, not a waveform widget.
 *
 * Plan §5.3 asks for "a slow, hand-built amplitude line driven by real
 * microphone RMS. Not a stock waveform library", and the difference is not
 * decoration. A row of mirrored bars bouncing at 60fps is the single most
 * recognisable tell of a generated interface (R-50), and this is the element a
 * visitor stares at for the whole conversation.
 *
 * So what is drawn here is a chart recorder: a hairline ruled across paper,
 * with the pen resting on it. Speech pushes the pen up off the rule — upward
 * only, never mirrored — and the deflection scrolls leftward at a fixed slow
 * cadence, fading as it ages. What you see is the shape of the sentence you
 * just spoke drifting away, not a decorative wobble that resets.
 *
 * Four decisions that make it read as drawn rather than generated:
 *
 *   - **The rule is not straight.** A fixed table of sub-pixel offsets, seeded
 *     once, gives the baseline the waver of a line drawn against a ruler. The
 *     trace carries the same offsets, so at rest the two are one line.
 *   - **The pen has mass.** Level is smoothed with a fast attack and a slow
 *     release, so it swells and settles rather than tracking the microphone
 *     sample for sample. Plan §4 asks for calm; calm is mostly release time.
 *   - **The scroll is slower than the frame rate.** History advances at 24
 *     samples a second regardless of display refresh, which is what stops the
 *     trace from shimmering.
 *   - **Deflection is calibrated against a real number.** Full travel is a
 *     multiple of `BARGE_IN.rmsThreshold`, the level the orchestrator already
 *     treats as "the visitor is talking", so the line reaching its top means
 *     something rather than looking good.
 *
 * `thinking` is deliberately a different gesture, not the same motion in
 * another colour (plan §14 forbids colour-only meaning): the pen lifts off the
 * history and one shallow swell travels the length of the rule and back,
 * ignoring the microphone entirely. `speaking` and `idle` are quiet, and are
 * still told apart by shape — a dashed rule for the lifted pen against a solid
 * one for the resting pen.
 *
 * Accessibility: the drawing carries no information a screen reader can reach,
 * so the word is the real status and the picture is `aria-hidden`. The word is
 * written only when the state changes; writing it every frame would turn a
 * `role="status"` region into a firehose.
 */

import type { TalkState } from '../../agent/orchestrator.js';
import { BARGE_IN } from '../../config/settings.js';
import { el, prefersReducedMotion } from '../a11y.js';
import type { Component } from './component.js';

import '../styles/components/listening-indicator.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/* ------------------------------------------------------------- geometry -- */

/**
 * viewBox units. The stylesheet gives the element the same 6:1 ratio, which is
 * why `preserveAspectRatio` is left alone: under a non-uniform stretch the pen
 * nib would render as an ellipse.
 */
const VIEW_W = 240;
const VIEW_H = 40;
/** The rule sits low, because the pen only ever deflects upward. */
const BASE_Y = 30;
const MAX_RISE = 23;
const X_INSET = 1;

/** 96 columns at 24 samples a second is four seconds of visible history. */
const COLUMNS = 96;
const SAMPLE_INTERVAL_MS = 1000 / 24;

/** How much the oldest column is flattened, so the tail settles into the rule. */
const TAIL_FADE = 0.5;

/* --------------------------------------------------------------- motion -- */

/**
 * Attack is quick enough that a syllable registers; release is slow enough that
 * the gaps between words do not read as flicker. These two numbers are most of
 * what "calm" means here.
 */
const ATTACK_MS = 110;
const RELEASE_MS = 380;

/** A backgrounded tab hands back one enormous delta. Clamp it. */
const MAX_FRAME_MS = 64;

const THINK_PERIOD_MS = 2600;
const THINK_AMPLITUDE = 0.34;
const THINK_WIDTH = 0.13;

/* ---------------------------------------------------------------- level -- */

/**
 * Anything below a quarter of the barge-in threshold is room tone, and the line
 * must be genuinely still in a quiet room rather than merely nearly still.
 */
const NOISE_FLOOR = BARGE_IN.rmsThreshold / 4;
/** Full deflection. A shout, not a conversational level. */
const FULL_SCALE = BARGE_IN.rmsThreshold * 3.5;

const STATUS_LABEL: Readonly<Record<TalkState, string>> = {
  idle: '',
  warming: 'Starting up',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

/**
 * RMS is energy, not loudness. The exponent pulls conversational speech into
 * the middle of the travel, where the line is legible, instead of leaving it
 * hugging the rule.
 */
function normalise(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  const scaled = (raw - NOISE_FLOOR) / (FULL_SCALE - NOISE_FLOOR);
  if (scaled <= 0) return 0;
  return Math.min(1, scaled) ** 0.7;
}

function columnX(index: number): number {
  return X_INSET + (index * (VIEW_W - 2 * X_INSET)) / (COLUMNS - 1);
}

/**
 * The waver of a hand-ruled line, in viewBox units.
 *
 * A linear congruential generator rather than `Math.random` so the same
 * imperfection ships on every load and to every visitor — a line that re-rolls
 * its own texture on refresh is a line nobody drew.
 */
function baselineWaver(): readonly number[] {
  const out: number[] = [];
  let seed = 0x2f6e2b1;
  for (let i = 0; i < COLUMNS; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out.push((seed / 0x7fffffff - 0.5) * 0.7);
  }
  return out;
}

function swell(x: number, centre: number, width: number): number {
  const d = (x - centre) / width;
  return Math.exp(-d * d);
}

/* ----------------------------------------------------------------- fills -- */

function fillRest(out: number[]): void {
  out.fill(0);
}

function fillTravelling(out: number[], centre: number): void {
  for (let i = 0; i < COLUMNS; i += 1) {
    out[i] = THINK_AMPLITUDE * swell(i / (COLUMNS - 1), centre, THINK_WIDTH);
  }
}

/**
 * The still shape shown for `listening` when motion is off: two swells, as if
 * the recorder had already run. A flat line would say "no microphone" to
 * exactly the visitor who cannot check by watching it move.
 */
function fillRecorded(out: number[]): void {
  for (let i = 0; i < COLUMNS; i += 1) {
    const x = i / (COLUMNS - 1);
    out[i] = 0.3 * swell(x, 0.62, 0.2) + 0.17 * swell(x, 0.28, 0.14);
  }
}

function fillFromHistory(out: number[], history: readonly number[]): void {
  for (let i = 0; i < COLUMNS; i += 1) {
    const age = i / (COLUMNS - 1);
    out[i] = (history[i] ?? 0) * (TAIL_FADE + (1 - TAIL_FADE) * age);
  }
}

/* ------------------------------------------------------------ component -- */

export interface ListeningIndicatorProps {
  readonly active: boolean;
  readonly state: TalkState;
}

export function createListeningIndicator(options: {
  readonly level: () => number;
}): Component<ListeningIndicatorProps> {
  const waver = baselineWaver();

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.setAttribute('class', 'listening-indicator__wave');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const rule = document.createElementNS(SVG_NS, 'path');
  rule.setAttribute('class', 'listening-indicator__rule');
  rule.setAttribute('d', rulePath(waver));

  const trace = document.createElementNS(SVG_NS, 'polyline');
  trace.setAttribute('class', 'listening-indicator__trace');

  const nib = document.createElementNS(SVG_NS, 'circle');
  nib.setAttribute('class', 'listening-indicator__dot');
  nib.setAttribute('r', '2.4');

  svg.append(rule, trace, nib);

  const status = el('p', { className: 'listening-indicator__status', attrs: { role: 'status' } });
  const root = el('div', { className: 'listening-indicator', children: [svg, status] });

  /** One scratch array, reused every frame. The loop allocates nothing else. */
  const shaped: number[] = new Array<number>(COLUMNS).fill(0);
  const history: number[] = new Array<number>(COLUMNS).fill(0);

  let active = false;
  let state: TalkState = 'idle';
  let statusText = '';
  let smoothed = 0;
  let carryMs = 0;
  let thinkPhase = 0;
  let lastFrameAt = 0;
  let lastPoints = '';
  let rafId: number | null = null;

  /**
   * Write the trace and put the nib on it.
   *
   * `nibAt` is a position along the line in 0..1, or null when the pen is off
   * the paper — the stylesheet hides it in that case, so nothing needs moving.
   */
  const draw = (values: readonly number[], nibAt: number | null): void => {
    let points = '';
    for (let i = 0; i < COLUMNS; i += 1) {
      const y = BASE_Y + (waver[i] ?? 0) - (values[i] ?? 0) * MAX_RISE;
      points += `${i === 0 ? '' : ' '}${columnX(i).toFixed(2)},${y.toFixed(2)}`;
    }
    // A silent room produces the same string every frame. Not writing it is the
    // difference between an idle tab doing nothing and an idle tab painting.
    if (points !== lastPoints) {
      trace.setAttribute('points', points);
      lastPoints = points;
    }

    if (nibAt === null) return;
    const index = Math.round(nibAt * (COLUMNS - 1));
    nib.setAttribute('cx', columnX(index).toFixed(2));
    nib.setAttribute(
      'cy',
      (BASE_Y + (waver[index] ?? 0) - (values[index] ?? 0) * MAX_RISE).toFixed(2),
    );
  };

  const frame = (now: number): void => {
    rafId = requestAnimationFrame(frame);
    const dt = lastFrameAt === 0 ? SAMPLE_INTERVAL_MS : Math.min(now - lastFrameAt, MAX_FRAME_MS);
    lastFrameAt = now;

    if (state === 'thinking') {
      thinkPhase = (thinkPhase + dt / THINK_PERIOD_MS) % 1;
      // Cosine rather than a sawtooth: the swell slows at each end and turns
      // around instead of snapping back to the left margin.
      const centre = 0.5 - 0.5 * Math.cos(thinkPhase * 2 * Math.PI);
      fillTravelling(shaped, centre);
      draw(shaped, centre);
      return;
    }

    const target = normalise(options.level());
    // Frame-rate independent smoothing: the same time constant whether the
    // display runs at 60Hz or 120Hz.
    const tau = target > smoothed ? ATTACK_MS : RELEASE_MS;
    smoothed += (target - smoothed) * (1 - Math.exp(-dt / tau));

    carryMs += dt;
    while (carryMs >= SAMPLE_INTERVAL_MS) {
      carryMs -= SAMPLE_INTERVAL_MS;
      history.shift();
      history.push(smoothed);
    }
    // The newest column keeps tracking between samples, so the nib moves
    // continuously while the history behind it steps.
    history[COLUMNS - 1] = smoothed;

    fillFromHistory(shaped, history);
    draw(shaped, 1);
  };

  const stop = (): void => {
    if (rafId === null) return;
    cancelAnimationFrame(rafId);
    rafId = null;
  };

  const start = (): void => {
    if (rafId !== null) return;
    lastFrameAt = 0;
    rafId = requestAnimationFrame(frame);
  };

  /** The shape held when nothing is animating, including under reduced motion. */
  const renderStill = (): void => {
    // Leaving `listening` lifts the pen: the history does not bleed into the
    // next turn, and the agent's own speech never reads as the visitor's.
    smoothed = 0;
    carryMs = 0;
    history.fill(0);

    if (!active) {
      fillRest(shaped);
      draw(shaped, null);
      return;
    }
    if (state === 'listening') {
      fillRecorded(shaped);
      draw(shaped, 1);
      return;
    }
    if (state === 'thinking') {
      fillTravelling(shaped, 0.5);
      draw(shaped, 0.5);
      return;
    }
    fillRest(shaped);
    draw(shaped, state === 'warming' ? 1 : null);
  };

  const sync = (): void => {
    root.setAttribute('data-state', state);
    root.setAttribute('data-active', active ? 'true' : 'false');

    const label = active ? STATUS_LABEL[state] : '';
    if (label !== statusText) {
      statusText = label;
      status.textContent = label;
    }

    const animate =
      active && (state === 'listening' || state === 'thinking') && !prefersReducedMotion();
    if (animate) {
      start();
    } else {
      stop();
      renderStill();
    }
  };

  const motion = typeof matchMedia === 'function' ? matchMedia(REDUCED_MOTION_QUERY) : null;
  // The preference can change while the page is open — a visitor turning it on
  // mid-conversation is exactly the visitor who needs it honoured immediately.
  const onMotionChange = (): void => sync();
  motion?.addEventListener('change', onMotionChange);

  sync();

  return {
    el: root,

    update(props: ListeningIndicatorProps): void {
      if (props.state !== state) thinkPhase = 0;
      active = props.active;
      state = props.state;
      sync();
    },

    destroy(): void {
      stop();
      motion?.removeEventListener('change', onMotionChange);
    },
  };
}

/** The ruled line itself. Built once — only `points` and the nib move. */
function rulePath(waver: readonly number[]): string {
  let d = '';
  for (let i = 0; i < COLUMNS; i += 1) {
    if (i > 0) d += ' ';
    d += `${i === 0 ? 'M' : 'L'}${columnX(i).toFixed(2)},${(BASE_Y + (waver[i] ?? 0)).toFixed(2)}`;
  }
  return d;
}
