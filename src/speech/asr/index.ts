/**
 * Endpointing (T-042), adapter selection, and the echo contract (T-049).
 *
 * **Endpointing is what defines t0.** The whole latency budget in plan §12.5 is
 * measured from end-of-speech, so if end-of-speech is detected late every number
 * downstream is wrong by that much and no amount of work on the model or the
 * synthesis will get it back. The browser's own `final` event is the obvious
 * signal and it is too slow and too inconsistent to be the primary one — Chrome
 * can sit on it for the better part of a second. So silence after the last
 * interim result is the primary signal, `final` is a shortcut when it happens to
 * arrive first, and `LISTENING.endpointSilenceMs` is the one number that decides
 * whether the agent feels attentive or feels like it is interrupting.
 *
 * `createEndpointer` takes its clock as an argument to every method and owns no
 * timer. That is not fastidiousness: "fires exactly once per turn" is T-042's
 * acceptance criterion, and the only way to assert it honestly is to drive the
 * thing through a simulated second and count. The single real interval lives in
 * `withEndpointing`, where it does nothing but read the clock.
 */

import { LISTENING } from '../../config/settings.js';
import type { SpeechInput, SpeechInputHandlers, TranscriptEvent } from '../../agent/ports.js';
import { createWebSpeechInput } from './webspeech.js';

/** How often the composed input asks the endpointer whether silence is up. */
const ENDPOINT_TICK_MS = 50;

/**
 * Resolved at runtime, not at build time.
 *
 * `src/speech/asr/hosted.ts` is a later task and does not exist yet. Typing the
 * specifier as `string` rather than a literal keeps TypeScript from trying to
 * resolve a module that is not there, so this file compiles and ships today
 * with Web Speech alone and picks up the hosted path the moment the file lands,
 * with no edit here. A caller that already has a hosted adapter should inject it
 * through `options.hosted` and skip this entirely.
 */

/* ----------------------------------------------------------- endpointer -- */

export interface EndpointerOptions {
  /** Defaults to `LISTENING.endpointSilenceMs`. */
  readonly silenceMs?: number;
  onEndOfSpeech(text: string): void;
}

export interface Endpointer {
  push(event: TranscriptEvent, atMs: number): void;
  tick(atMs: number): void;
  /** Re-arm for the next turn. Cancels any pending fire. */
  reset(): void;
  /** True when a turn is in progress and end-of-speech has not fired yet. */
  isPending(): boolean;
}

/**
 * Fire end-of-speech once per turn: on `silenceMs` of quiet after the last
 * interim that carried text, or on a final result, whichever comes first.
 *
 * After it fires it stays disarmed until `reset()`. The alternative — treating
 * the next interim as a new turn — silently swallows the case where the
 * orchestrator forgets to close a turn, and a turn loop that quietly emits two
 * t0 marks is worse than one that emits none.
 */
export function createEndpointer(options: EndpointerOptions): Endpointer {
  const silenceMs = options.silenceMs ?? LISTENING.endpointSilenceMs;

  let text = '';
  /** When the last text-bearing event arrived, or null when the turn is idle. */
  let lastAtMs: number | null = null;
  let armed = true;

  const fire = (): void => {
    armed = false;
    lastAtMs = null;
    const spoken = text.trim();
    text = '';
    options.onEndOfSpeech(spoken);
  };

  return {
    push(event: TranscriptEvent, atMs: number): void {
      if (!armed) return;
      const candidate = event.text.trim();
      if (candidate !== '') text = candidate;
      if (event.isFinal) {
        fire();
        return;
      }
      // An empty interim is the recogniser saying "still listening, nothing
      // yet". It must not start the silence timer, or a session that is merely
      // open would end a turn nobody began.
      if (candidate === '') return;
      lastAtMs = atMs;
    },

    tick(atMs: number): void {
      if (!armed || lastAtMs === null) return;
      if (atMs - lastAtMs < silenceMs) return;
      fire();
    },

    reset(): void {
      text = '';
      lastAtMs = null;
      armed = true;
    },

    isPending(): boolean {
      return armed && lastAtMs !== null;
    },
  };
}

/* ------------------------------------------------------------ selection -- */

/**
 * iOS, as far as it can be determined.
 *
 * Plan §4.7 routes iOS Safari to hosted recognition because the built-in one is
 * unreliable there: it truncates, it stops without an error, and `continuous`
 * is close to meaningless. There is no feature to detect for "recognition that
 * exists but does not work", so this is a user-agent sniff, and saying so is
 * better than dressing it up. iPadOS is the part that catches people out — it
 * reports `MacIntel` and has to be identified by having a touch screen, which is
 * the one genuine feature test in here.
 */
export function isProbablyIos(): boolean {
  const nav = globalThis.navigator as
    | { userAgent?: string; platform?: string; maxTouchPoints?: number }
    | undefined;
  if (nav === undefined) return false;
  const ua = nav.userAgent ?? '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ masquerades as desktop Safari; a Mac with a touch screen is an
  // iPad.
  return (nav.platform ?? '') === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1;
}

/**
 * Hosted recognition is **injected, not imported**.
 *
 * It needs a configured gateway client, which only the composition root has —
 * so this module cannot construct one itself without either importing the
 * gateway (coupling recognition to the network layer) or guessing. The caller
 * passes it in, or there is no hosted rung.
 *
 * The practical consequence: a site built with no gateway URL has exactly two
 * recognition options, Web Speech and typing, which is correct.
 */

/** F7/F8's floor: never absent, never throwing, always explicable. */
export function createUnsupportedInput(): SpeechInput {
  return {
    kind: 'none',
    isAvailable: () => Promise.resolve(false),
    start(handlers: SpeechInputHandlers): Promise<void> {
      handlers.onError({ kind: 'not_supported' });
      return Promise.resolve();
    },
    stop: () => undefined,
    setMuted: () => undefined,
    level: () => 0,
  };
}

/* ------------------------------------------------------------- composed -- */

export interface ComposedSpeechInput extends SpeechInput {
  /**
   * Begin a new turn. Re-arms the endpointer so t0 can fire again.
   *
   * `setMuted(false)` does this too, because unmuting is what starting to listen
   * looks like from here.
   */
  resetTurn(): void;
}

export interface EndpointingOptions {
  readonly silenceMs?: number;
  readonly tickMs?: number;
  readonly now?: () => number;
}

function defaultNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/**
 * Wrap an input so that `handlers.onEndOfSpeech` comes from the endpointer
 * rather than from whatever the underlying recogniser felt like emitting.
 *
 * An adapter that does its own endpointing — the hosted one will — feeds its
 * verdict in as a final result, so both paths converge on one implementation of
 * "once per turn" instead of two that drift.
 */
export function withEndpointing(inner: SpeechInput, options: EndpointingOptions = {}): ComposedSpeechInput {
  const silenceMs = options.silenceMs ?? LISTENING.endpointSilenceMs;
  const tickMs = options.tickMs ?? ENDPOINT_TICK_MS;
  const now = options.now ?? defaultNow;

  let endpointer: Endpointer | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopTicking = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  return {
    kind: inner.kind,

    isAvailable: () => inner.isAvailable(),

    async start(handlers: SpeechInputHandlers): Promise<void> {
      const point = createEndpointer({ silenceMs, onEndOfSpeech: handlers.onEndOfSpeech });
      endpointer = point;
      stopTicking();
      timer = setInterval(() => {
        point.tick(now());
      }, tickMs);
      await inner.start({
        onTranscript(event: TranscriptEvent): void {
          handlers.onTranscript(event);
          point.push(event, now());
        },
        onEndOfSpeech(text: string): void {
          point.push({ text, isFinal: true }, now());
        },
        onError: handlers.onError.bind(handlers),
      });
    },

    stop(): void {
      stopTicking();
      endpointer?.reset();
      inner.stop();
    },

    setMuted(muted: boolean): void {
      if (!muted) endpointer?.reset();
      inner.setMuted(muted);
    },

    level: () => inner.level(),

    resetTurn(): void {
      endpointer?.reset();
    },
  };
}

export interface SpeechInputOptions extends EndpointingOptions {
  /** BCP-47 tag for the recogniser. */
  readonly locale?: string;
  /** Skip selection entirely and use this. */
  readonly webspeech?: SpeechInput;
  /** Supply the hosted adapter directly instead of importing it. */
  readonly hosted?: SpeechInput;
  /** Override the iOS heuristic. */
  readonly preferHosted?: boolean;
}

/**
 * Pick a recogniser and wire the endpointer to it.
 *
 * Order is plan §7.5's F7 read forwards: Web Speech where it works, hosted where
 * it does not or where it is known to misbehave (iOS), and an input that
 * explains itself when neither is there — which is what routes the session to
 * typed mode instead of to a dead button.
 */
export async function createSpeechInput(options: SpeechInputOptions = {}): Promise<ComposedSpeechInput> {
  const locale = options.locale ?? 'en-IN';
  const preferHosted = options.preferHosted ?? isProbablyIos();

  const loadHosted = async (): Promise<SpeechInput | null> => {
    const hosted = options.hosted;
    if (hosted === undefined) return null;
    // Asked, not assumed. A hosted adapter built against an unconfigured
    // gateway reports itself unavailable, and picking it anyway would strand a
    // Firefox visitor on a path that cannot work instead of offering typing.
    return (await hosted.isAvailable()) ? hosted : null;
  };

  const loadWebSpeech = async (): Promise<SpeechInput | null> => {
    const candidate = options.webspeech ?? createWebSpeechInput({ locale });
    return (await candidate.isAvailable()) ? candidate : null;
  };

  const order = preferHosted ? [loadHosted, loadWebSpeech] : [loadWebSpeech, loadHosted];
  let chosen: SpeechInput | null = null;
  for (const load of order) {
    chosen = await load();
    if (chosen !== null) break;
  }

  const endpointing: EndpointingOptions = {
    ...(options.silenceMs === undefined ? {} : { silenceMs: options.silenceMs }),
    ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return withEndpointing(chosen ?? createUnsupportedInput(), endpointing);
}

export { createWebSpeechInput, isWebSpeechSupported } from './webspeech.js';
