/**
 * The speech floor (T-044).
 *
 * This is the last level of the synthesis cascade in plan §7.5 and the only one
 * that costs nothing and needs no network. It is not as good as a hosted neural
 * voice and it is not trying to be — it is the reason the demo still talks when
 * the gateway is unreachable, the daily ceiling is spent, or the visitor has no
 * connection at all.
 *
 * It is also the one adapter that does not return audio. `resolve()` hands back
 * a `SpeechClip` with `audio: null` and `source: 'browser'`, which is the port's
 * signal that the caller must call `speak()` instead of pushing bytes into the
 * audio queue. `speechSynthesis` owns its own output device and there is no API
 * to intercept it; the consequence the orchestrator has to live with is that
 * barge-in on this path is `cancel()`, not `AudioQueue.flush()`.
 *
 * Two browser behaviours are worked around rather than reported:
 *
 *   - Voice lists load asynchronously in Chrome and Safari and are empty on the
 *     first call. `voiceschanged` fixes it when it fires and sometimes does not
 *     fire at all, so the wait is bounded and whatever is there is used.
 *   - Long utterances stall. Chrome has shipped a version of this bug for years;
 *     past a few hundred characters an utterance can simply stop mid-sentence
 *     and never fire `onend`. Text is split at sentence boundaries under
 *     `SPEECH.maxSentenceChars` and spoken as a sequence, which avoids the bug
 *     and happens to be the same chunking the streaming path already uses.
 */

import { SPEECH } from '../../config/settings.js';
import type { SpeechClip, SpeechOutput, SpeechRequest } from '../../agent/ports.js';

/** How long to wait for `voiceschanged` before using whatever is available. */
const VOICE_LIST_TIMEOUT_MS = 500;
/**
 * Safety net for an utterance that never ends.
 *
 * Speech runs at roughly twelve characters a second, so this is a generous
 * multiple of the expected duration. It settles the promise; it does not stop
 * the browser talking. Hanging forever would strand the turn loop, and a turn
 * loop that never advances is a worse failure than one line overlapping.
 */
function watchdogMs(text: string): number {
  return 5_000 + Math.ceil(text.length / 12) * 1_000 * 2;
}

interface SynthesisScope {
  speechSynthesis?: SpeechSynthesis;
  SpeechSynthesisUtterance?: new (text: string) => SpeechSynthesisUtterance;
}

function scope(): SynthesisScope {
  return globalThis as unknown as SynthesisScope;
}

function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/* ------------------------------------------------------ voice selection -- */

function normaliseTag(tag: string): string {
  return tag.replace('_', '-').toLowerCase();
}

/** Fallback order from plan §4: Indian English first, then the other Englishes. */
const LOCALE_PREFERENCE = ['en-in', 'en-gb', 'en-us'];

/**
 * Names that tend to mark a better voice.
 *
 * The API exposes no quality signal whatsoever, so this is pattern matching on
 * vendor naming conventions and it will be wrong on some platform eventually.
 * It only ever breaks ties within the same locale, so being wrong costs a
 * slightly worse voice and nothing else.
 */
const QUALITY_HINTS = /natural|neural|enhanced|premium|siri|google/i;

export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
  locale: string,
): SpeechSynthesisVoice | null {
  const wanted = normaliseTag(locale);
  const english = voices.filter((voice) => normaliseTag(voice.lang).startsWith('en'));
  const pool = english.length > 0 ? english : voices;
  if (pool.length === 0) return null;

  const rank = (voice: SpeechSynthesisVoice): number => {
    const lang = normaliseTag(voice.lang);
    let score: number;
    if (lang === wanted) score = 0;
    else {
      const index = LOCALE_PREFERENCE.indexOf(lang);
      score = index >= 0 ? 1 + index : 10;
    }
    score *= 100;
    // Local voices start instantly and work offline, which matters more than a
    // network voice sounding marginally better on the level below the network.
    if (!voice.localService) score += 20;
    if (!QUALITY_HINTS.test(voice.name)) score += 5;
    if (!voice.default) score += 1;
    return score;
  };

  let best = pool[0] ?? null;
  if (best === null) return null;
  let bestScore = rank(best);
  for (const voice of pool) {
    const score = rank(voice);
    if (score < bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return best;
}

/* ---------------------------------------------------------- text splitting -- */

/** Split at sentence boundaries, then whitespace, then not at all. */
export function splitForSynthesis(text: string, maxChars: number = SPEECH.maxSentenceChars): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const parts: string[] = [];
  let rest = trimmed;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
    if (cut > 0) cut += 1;
    else {
      cut = window.lastIndexOf(' ');
      if (cut <= 0) cut = maxChars;
    }
    const piece = rest.slice(0, cut).trim();
    if (piece !== '') parts.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') parts.push(rest);
  return parts;
}

/* --------------------------------------------------------------- adapter -- */

export interface BrowserSpeechOutput extends SpeechOutput {
  readonly kind: 'browser';
  /** False where `speechSynthesis` is missing. Never throws, never prompts. */
  isAvailable(): boolean;
  speak(request: SpeechRequest, signal?: AbortSignal): Promise<void>;
}

export function createBrowserSpeechOutput(): BrowserSpeechOutput {
  /** Everything waiting on an utterance, so `cancel()` can settle all of it. */
  const pending = new Set<() => void>();
  let voicePromise: Promise<readonly SpeechSynthesisVoice[]> | null = null;

  const synth = (): SpeechSynthesis | null => scope().speechSynthesis ?? null;

  const available = (): boolean => synth() !== null && scope().SpeechSynthesisUtterance !== undefined;

  const voices = (): Promise<readonly SpeechSynthesisVoice[]> => {
    if (voicePromise !== null) return voicePromise;
    const engine = synth();
    if (engine === null) {
      voicePromise = Promise.resolve([]);
      return voicePromise;
    }
    voicePromise = new Promise<readonly SpeechSynthesisVoice[]>((done) => {
      const read = (): SpeechSynthesisVoice[] => {
        try {
          return engine.getVoices();
        } catch {
          return [];
        }
      };
      const initial = read();
      if (initial.length > 0) {
        done(initial);
        return;
      }
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          engine.removeEventListener('voiceschanged', finish);
        } catch {
          // No event target here; the timeout was the path that fired.
        }
        engine.onvoiceschanged = null;
        done(read());
      };
      const timer = setTimeout(finish, VOICE_LIST_TIMEOUT_MS);
      try {
        engine.addEventListener('voiceschanged', finish);
      } catch {
        // Older engines expose only the handler property, set below.
      }
      engine.onvoiceschanged = finish;
    });
    return voicePromise;
  };

  const cancel = (): void => {
    const engine = synth();
    if (engine !== null) {
      try {
        engine.cancel();
      } catch {
        // Nothing queued.
      }
    }
    // Cancelling does not reliably fire `onend` in every browser, so in-flight
    // promises are settled here rather than left to the engine's goodwill.
    for (const settle of [...pending]) settle();
  };

  const utter = (text: string, request: SpeechRequest, signal?: AbortSignal): Promise<void> => {
    const engine = synth();
    const Utterance = scope().SpeechSynthesisUtterance;
    if (engine === null || Utterance === undefined) return Promise.resolve();

    return voices().then(
      (available) =>
        new Promise<void>((done) => {
          if (signal?.aborted === true) {
            done();
            return;
          }
          const utterance = new Utterance(text);
          const voice = pickVoice(available, request.locale);
          if (voice !== null) {
            utterance.voice = voice;
            utterance.lang = voice.lang;
          } else {
            utterance.lang = request.locale;
          }

          let settled = false;
          const settle = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            pending.delete(settle);
            signal?.removeEventListener('abort', onAbort);
            utterance.onend = null;
            utterance.onerror = null;
            done();
          };
          const onAbort = (): void => {
            try {
              engine.cancel();
            } catch {
              // Nothing queued.
            }
            settle();
          };
          const timer = setTimeout(settle, watchdogMs(text));

          pending.add(settle);
          utterance.onend = settle;
          utterance.onerror = settle;
          signal?.addEventListener('abort', onAbort, { once: true });

          try {
            engine.speak(utterance);
          } catch {
            settle();
          }
        }),
    );
  };

  return {
    kind: 'browser',

    isAvailable: available,

    async resolve(_request: SpeechRequest, signal?: AbortSignal): Promise<SpeechClip> {
      const startedAt = nowMs();
      // Nothing to fetch — the only real work is having a voice list, and the
      // measurement exists so the readout can show what this level costs
      // alongside the hosted one rather than showing a zero it did not earn.
      if (signal?.aborted !== true) await voices();
      return {
        source: 'browser',
        audio: null,
        resolvedInMs: Math.round(nowMs() - startedAt),
      };
    },

    async speak(request: SpeechRequest, signal?: AbortSignal): Promise<void> {
      if (!available()) return;
      for (const chunk of splitForSynthesis(request.text)) {
        if (signal?.aborted === true) return;
        await utter(chunk, request, signal);
      }
    },

    cancel,

    async warm(): Promise<void> {
      // Loading the voice list is the whole of the setup cost (R-24). Speaking
      // a silent utterance to prime the engine needs a user gesture, so the
      // orchestrator does that from the Talk button instead.
      await voices();
    },
  };
}
