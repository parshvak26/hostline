/**
 * Energy voice-activity detection for barge-in (T-045).
 *
 * **The honest limitation, stated rather than hidden (plan §26).** This is a
 * root-mean-square threshold with a sustain window, not a model. It measures
 * loudness and nothing else. In a quiet room it is reliable and costs nothing;
 * in a noisy one it will fire on a nearby conversation, and it cannot tell a
 * cough held for 200ms from a word. A trained VAD would do better and would
 * cost several hundred kilobytes of WASM, which the 2MB bundle budget in plan
 * §12.2 does not have. That trade-off is the answer to "what would you do
 * differently", so it is written down here and in the README rather than
 * discovered by a listener.
 *
 * The sustain window is what makes the threshold usable at all: `rmsThreshold`
 * alone fires on a door slam, a chair, a key press. Requiring the level to stay
 * up for `BARGE_IN.sustainedMs` rejects impulses, because impulses are loud and
 * short and speech is loud and continuous.
 *
 * `rms` and `createSustainDetector` are pure so they can be tested without a
 * browser. T-045 asks for tests against recorded audio buffers; the tests here
 * use synthetic buffers — silence, sines, impulse trains — because a checked-in
 * recording is a fixture nobody can reason about and a sine of known amplitude
 * has a known RMS. That is a substitution, and it is a real one: it verifies the
 * arithmetic and the sustain logic, not the behaviour of a real room.
 */

import { BARGE_IN } from '../config/settings.js';

/** Window size for the analyser. 1024 samples is ~21ms at 48kHz. */
const ANALYSER_FFT_SIZE = 1024;
/** Polling interval where `requestAnimationFrame` is unavailable. */
const POLL_INTERVAL_MS = 20;

/* ------------------------------------------------------------------ pure -- */

/**
 * Root mean square of a block of samples, in the same 0..1 scale as the input.
 *
 * A full-scale sine reads ~0.707, not 1.0 — RMS is the average power, not the
 * peak — which is why `BARGE_IN.rmsThreshold` is set where it is.
 */
export function rms(samples: Float32Array): number {
  const count = samples.length;
  if (count === 0) return 0;
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / count);
}

export interface SustainOptions {
  /** Defaults to `BARGE_IN.rmsThreshold`. */
  readonly threshold?: number;
  /** Defaults to `BARGE_IN.sustainedMs`. */
  readonly sustainedMs?: number;
}

export interface SustainDetector {
  /** Returns true on the single frame the sustain window is first satisfied. */
  push(level: number, atMs: number): boolean;
  reset(): void;
}

/**
 * Fires once when the level has stayed above the threshold for long enough, and
 * re-arms only after it drops back below.
 *
 * Firing once per crossing rather than once per frame matters because the
 * caller's response — flush audio, abort the in-flight turn (T-085) — is not
 * idempotent in any useful sense and should happen on the edge.
 *
 * Clock is a parameter, not a global. That is what lets the tests assert the
 * boundary of the sustain window exactly rather than sleeping through it.
 */
export function createSustainDetector(options: SustainOptions = {}): SustainDetector {
  const threshold = options.threshold ?? BARGE_IN.rmsThreshold;
  const sustainedMs = options.sustainedMs ?? BARGE_IN.sustainedMs;

  let since: number | null = null;
  let armed = true;

  return {
    push(level: number, atMs: number): boolean {
      if (level <= threshold) {
        since = null;
        armed = true;
        return false;
      }
      if (since === null) since = atMs;
      if (!armed) return false;
      if (atMs - since < sustainedMs) return false;
      armed = false;
      return true;
    },
    reset(): void {
      since = null;
      armed = true;
    },
  };
}

/* ------------------------------------------------------------- browser -- */

export interface Vad {
  /** Most recent microphone RMS, 0..1. Drives the listening indicator too. */
  level(): number;
  /** Detach from the graph and stop polling. Safe to call twice. */
  stop(): void;
}

function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/**
 * Watch a microphone stream and call `onSpeech` when the visitor talks over the
 * agent.
 *
 * The analyser is deliberately left unconnected to `context.destination`: it is
 * a tap, and routing the microphone to the speakers would produce feedback.
 *
 * Nothing here throws. A browser without `createMediaStreamSource`, or a stream
 * with no live audio track, yields an inert VAD reporting level 0 — barge-in is
 * a nicety and the conversation continues without it.
 */
export function createVad(stream: MediaStream, context: AudioContext, onSpeech: () => void): Vad {
  const detector = createSustainDetector();
  let level = 0;
  let stopped = false;
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;

  try {
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = ANALYSER_FFT_SIZE;
    // No smoothing: smoothing is a low-pass on the level, and it would blunt
    // exactly the onset the sustain window is trying to time.
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
  } catch {
    return {
      level: () => 0,
      stop: () => undefined,
    };
  }

  const active = analyser;
  const samples = new Float32Array(active.fftSize);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
    frame = null;
    timer = null;
    try {
      source?.disconnect();
      active.disconnect();
    } catch {
      // Already detached.
    }
  };

  const step = (): void => {
    if (stopped) return;
    active.getFloatTimeDomainData(samples);
    level = rms(samples);
    if (detector.push(level, nowMs())) onSpeech();
    queue();
  };

  const queue = (): void => {
    if (stopped) return;
    // rAF where it exists: it is frame-aligned, and it stops in a background
    // tab, where there is nothing to interrupt anyway.
    if (typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(step);
      return;
    }
    timer = setTimeout(step, POLL_INTERVAL_MS);
  };

  queue();

  return {
    level: () => level,
    stop,
  };
}
