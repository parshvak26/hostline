/**
 * Browser speech recognition (T-041), and the echo gate (T-049).
 *
 * The Web Speech API is not in `lib.dom.d.ts` in any form this project can rely
 * on, so the shapes it needs are declared here and the global is cast through
 * `unknown` once, in `defaultRecognition`. Adding `@types/dom-speech-recognition`
 * for four interfaces would break the zero-dependency rule for no benefit.
 *
 * Two behaviours are worth reading before changing anything here.
 *
 * **Recognition stops on its own.** Safari ends a session after a pause, Chrome
 * ends one after `no-speech`, and neither is an error. So `onend` restarts while
 * the session is meant to be listening — but a restart that immediately ends
 * again is a spin, so restarts are counted and the counter is cleared by any
 * result. Eight consecutive restarts with nothing recognised is a broken
 * recogniser, and the session is told so rather than burning CPU forever.
 *
 * **Muting is gating, not echo cancellation.** `setMuted(true)` does not stop
 * the recogniser; it drops what the recogniser produces. That is R-25's actual
 * mechanism and it is worth being blunt about: this adapter cannot subtract the
 * agent's voice from the microphone signal. `echoCancellation: true` on the
 * media constraints does the acoustic half — it is what stops the speaker's
 * output arriving at the microphone at usable amplitude — and this gate does the
 * rest by refusing to believe anything heard while the agent is talking. The
 * residual case is a loud speaker in a hard room, where AEC leaks and the gate
 * still holds because the gate does not care how loud the leak is.
 */

import { LISTENING } from '../../config/settings.js';
import type { SpeechInput, SpeechInputError, SpeechInputHandlers } from '../../agent/ports.js';

const DEFAULT_LOCALE = 'en-IN';
const RESTART_DELAY_MS = 250;
/** Consecutive restarts with no result before the recogniser is declared dead. */
const MAX_RESTARTS_WITHOUT_RESULT = 8;

/* --------------------------------------------------- the undeclared API -- */

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string;
  readonly message?: string;
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionConstructor(): (new () => SpeechRecognitionLike) | null {
  const scope = globalThis as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  const ctor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  return typeof ctor === 'function' ? (ctor as new () => SpeechRecognitionLike) : null;
}

function defaultRecognition(): SpeechRecognitionLike | null {
  const Ctor = recognitionConstructor();
  if (Ctor === null) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/** True when the API is present. Deliberately does not touch the microphone. */
export function isWebSpeechSupported(): boolean {
  return recognitionConstructor() !== null;
}

/* ----------------------------------------------------------- error map -- */

export function mapRecognitionError(code: string, detail?: string): SpeechInputError {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return { kind: 'permission_denied' };
    case 'audio-capture':
      return { kind: 'no_microphone' };
    case 'network':
      return { kind: 'network' };
    case 'aborted':
      return { kind: 'aborted' };
    case 'language-not-supported':
    case 'service-unavailable':
      return { kind: 'not_supported' };
    default:
      return { kind: 'unknown', detail: detail === undefined ? code : `${code}: ${detail}` };
  }
}

/* ---------------------------------------------------------------- input -- */

export interface WebSpeechOptions {
  /** BCP-47 tag handed to the recogniser. Defaults to `en-IN`. */
  readonly locale?: string;
  /** Injected recogniser, for tests and for a stubbed integration harness. */
  readonly create?: () => SpeechRecognitionLike | null;
  /**
   * Microphone level source.
   *
   * Web Speech gives no access to the signal it is consuming, so this adapter
   * has no level of its own. The orchestrator opens the stream anyway for
   * `echoCancellation`, and wires `createVad(...).level` in here; with nothing
   * wired, `level()` reports 0 and the listening indicator stays flat.
   */
  readonly level?: () => number;
}

export function createWebSpeechInput(options: WebSpeechOptions = {}): SpeechInput {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const create = options.create ?? defaultRecognition;
  const readLevel = options.level ?? ((): number => 0);

  let recognition: SpeechRecognitionLike | null = null;
  let handlers: SpeechInputHandlers | null = null;
  /** The session wants transcripts. Cleared by `stop()` and by fatal errors. */
  let listening = false;
  let running = false;
  let muted = false;
  let restartsWithoutResult = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let unmuteTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRestart = (): void => {
    if (restartTimer === null) return;
    clearTimeout(restartTimer);
    restartTimer = null;
  };

  const clearUnmute = (): void => {
    if (unmuteTimer === null) return;
    clearTimeout(unmuteTimer);
    unmuteTimer = null;
  };

  const report = (error: SpeechInputError): void => {
    handlers?.onError(error);
  };

  const onResult = (event: SpeechRecognitionEventLike): void => {
    restartsWithoutResult = 0;
    // R-25. The recogniser keeps running while the agent speaks; what it heard
    // is simply not believed.
    if (muted || handlers === null) return;

    let text = '';
    let isFinal = false;
    let confidence: number | undefined;
    const results = event.results;
    for (let i = event.resultIndex; i < results.length; i += 1) {
      const result = results[i];
      if (result === undefined) continue;
      const alternative = result[0];
      if (alternative === undefined) continue;
      text += alternative.transcript;
      if (result.isFinal) {
        isFinal = true;
        confidence = alternative.confidence;
      }
    }

    const trimmed = text.trim();
    if (trimmed === '' && !isFinal) return;
    handlers.onTranscript(
      confidence === undefined ? { text: trimmed, isFinal } : { text: trimmed, isFinal, confidence },
    );
  };

  const onError = (event: SpeechRecognitionErrorEventLike): void => {
    const code = event.error;
    // Chrome fires `no-speech` whenever the visitor pauses. It is a pause, not
    // a failure, and surfacing it would put a warning on screen every few
    // seconds. `onend` restarts and the session continues.
    if (code === 'no-speech') return;
    // Our own `stop()` and `abort()` arrive here too.
    if (code === 'aborted' && !listening) return;

    if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
      // Restarting into a denied permission is a loop with a permission prompt
      // in it. F9 routes the session to typed input from here.
      listening = false;
      clearRestart();
    }
    report(mapRecognitionError(code, event.message));
  };

  const onEnd = (): void => {
    running = false;
    if (!listening) return;
    // Not while muted: the agent is speaking, and the restart happens when the
    // gate opens instead.
    if (muted) return;
    restartsWithoutResult += 1;
    if (restartsWithoutResult > MAX_RESTARTS_WITHOUT_RESULT) {
      listening = false;
      report({ kind: 'unknown', detail: 'recognition ended repeatedly without producing a result' });
      return;
    }
    clearRestart();
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launch();
    }, RESTART_DELAY_MS);
  };

  function launch(): void {
    if (running || !listening) return;
    const instance = recognition ?? create();
    if (instance === null) {
      listening = false;
      report({ kind: 'not_supported' });
      return;
    }
    recognition = instance;
    instance.continuous = true;
    instance.interimResults = true;
    instance.lang = locale;
    instance.maxAlternatives = 1;
    instance.onresult = onResult;
    instance.onerror = onError;
    instance.onend = onEnd;
    try {
      instance.start();
      running = true;
    } catch {
      // `InvalidStateError` when a previous session has not fully torn down.
      // Treat it as an unexpected end and come back through the restart path.
      running = false;
      onEnd();
    }
  }

  return {
    kind: 'webspeech',

    isAvailable(): Promise<boolean> {
      // Constructor presence only. Calling `getUserMedia` here would put a
      // permission prompt on page load, which is the one thing a capability
      // probe must not do.
      return Promise.resolve(options.create !== undefined || isWebSpeechSupported());
    },

    start(next: SpeechInputHandlers): Promise<void> {
      handlers = next;
      listening = true;
      muted = false;
      restartsWithoutResult = 0;
      clearRestart();
      clearUnmute();
      launch();
      return Promise.resolve();
    },

    stop(): void {
      listening = false;
      running = false;
      clearRestart();
      clearUnmute();
      const instance = recognition;
      if (instance === null) return;
      // Detach first: a stopped recogniser still delivers a trailing `onend`,
      // and an explicit stop must not be followed by a restart.
      instance.onend = null;
      instance.onresult = null;
      try {
        instance.stop();
      } catch {
        // Not started.
      }
      try {
        instance.abort();
      } catch {
        // Not started.
      }
    },

    setMuted(next: boolean): void {
      clearUnmute();
      if (next) {
        muted = true;
        return;
      }
      // `LISTENING.playbackMuteTailMs` after the agent stops, not at the
      // instant it stops: the last syllable is still travelling through the
      // recogniser's buffer and would otherwise arrive as a visitor turn. The
      // tail lives here rather than in the orchestrator so there is exactly one
      // of it — do not add a second one upstream.
      unmuteTimer = setTimeout(() => {
        unmuteTimer = null;
        muted = false;
        if (listening && !running) launch();
      }, LISTENING.playbackMuteTailMs);
    },

    level(): number {
      return readLevel();
    },
  };
}
