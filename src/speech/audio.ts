/**
 * The interruptible audio queue (T-043).
 *
 * Two requirements shape this file and nothing else does.
 *
 * The first is R-21: speech has to start before generation finishes, so audio
 * arrives as a stream of small chunks and each one is scheduled against a
 * running cursor rather than played when it happens to arrive. `setTimeout`
 * would be the obvious way to sequence them and it is the wrong one — it drifts
 * by whole tens of milliseconds under load, which is audible as a gap between
 * two halves of a sentence. The Web Audio clock does not drift, so each chunk
 * starts at `max(currentTime, cursor)` and the joins are sample-accurate.
 *
 * The second is R-22: `flush()` must silence everything inside one frame. That
 * is why nothing here waits — flush stops every live source synchronously,
 * invalidates in-flight decodes with a token, and returns. An e2e test asserts
 * the 150ms budget in `BARGE_IN.stopBudgetMs`, and any `await` on this path
 * would be the thing that breaks it.
 *
 * Decoded buffers are released as soon as their source ends. A ten-turn
 * conversation is a few hundred chunks, and holding their PCM would put the
 * heap well past the 80MB the plan budgets in §15.
 */

import type { AudioQueue } from '../agent/ports.js';

/* ------------------------------------------------------- injectable shapes -- */

/**
 * The Web Audio surface the queue actually uses.
 *
 * Deliberately structural and deliberately small: unit tests hand in an object
 * with five members instead of standing up a real `AudioContext`, which is not
 * available under the `node` test environment at all. The real context is cast
 * through `unknown` in `audioContextConstructor` — the only cast in the file.
 */
export interface AudioBufferLike {
  readonly duration: number;
}

export interface AudioSourceLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  connect(destination: unknown): void;
  disconnect(): void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  createBufferSource(): AudioSourceLike;
  resume(): Promise<void>;
}

export interface BrowserAudioQueue extends AudioQueue {
  /**
   * The context the queue built for itself, or null when one was injected or
   * Web Audio is absent.
   *
   * This is the whole of the coupling between this file and `vad.ts`: barge-in
   * detection wants an `AnalyserNode` on the microphone, and a page should have
   * one `AudioContext` rather than two. The VAD reads the input signal, not the
   * output, so it needs nothing else from the queue.
   */
  nativeContext(): AudioContext | null;
}

/* ------------------------------------------------------------- detection -- */

function audioContextConstructor(): (new () => AudioContext) | null {
  const scope = globalThis as unknown as {
    AudioContext?: unknown;
    webkitAudioContext?: unknown;
  };
  const ctor = scope.AudioContext ?? scope.webkitAudioContext;
  return typeof ctor === 'function' ? (ctor as new () => AudioContext) : null;
}

/* ----------------------------------------------------------------- queue -- */

export function createAudioQueue(context?: AudioContextLike): BrowserAudioQueue {
  let owned: AudioContext | null = null;
  let ctx: AudioContextLike | null = context ?? null;

  /** Sources that have been started and have not yet ended or been stopped. */
  const live = new Set<AudioSourceLike>();
  const listeners = new Set<() => void>();

  /** Scheduling clock, in context time. */
  let cursor = 0;
  /** Chunks accepted but not yet scheduled. Part of "is the queue busy". */
  let inflight = 0;
  /** Bumped by `flush()`; decodes that resolve with a stale token are dropped. */
  let generation = 0;
  /** Serialises scheduling so chunks play in the order they were enqueued. */
  let tail: Promise<void> = Promise.resolve();
  let playing = false;

  const ensureContext = (): AudioContextLike | null => {
    if (ctx !== null) return ctx;
    const Ctor = audioContextConstructor();
    if (Ctor === null) return null;
    try {
      owned = new Ctor();
    } catch {
      // Some embedded webviews expose the constructor and refuse to construct.
      return null;
    }
    ctx = owned as unknown as AudioContextLike;
    return ctx;
  };

  const drained = (): void => {
    if (live.size > 0 || inflight > 0) return;
    cursor = 0;
    if (!playing) return;
    playing = false;
    for (const listener of [...listeners]) listener();
  };

  const release = (source: AudioSourceLike): void => {
    source.onended = null;
    try {
      source.disconnect();
    } catch {
      // Already disconnected; nothing to undo.
    }
    // The decoded PCM is the expensive part. Dropping the reference here is
    // what keeps a long conversation flat rather than monotonically growing.
    source.buffer = null;
    live.delete(source);
  };

  const schedule = (active: AudioContextLike, buffer: AudioBufferLike): void => {
    const source = active.createBufferSource();
    source.buffer = buffer;
    source.connect(active.destination);
    source.onended = (): void => {
      release(source);
      drained();
    };
    const startAt = Math.max(active.currentTime, cursor);
    live.add(source);
    playing = true;
    source.start(startAt);
    cursor = startAt + buffer.duration;
  };

  return {
    async unlock(): Promise<void> {
      // F11: browsers hand back a suspended context until a gesture resumes it.
      // Idempotent by construction — resuming a running context is a no-op, and
      // a failure here is not worth propagating because the caller's only
      // recourse is to ask for another tap, which it will do anyway.
      const active = ensureContext();
      if (active === null) return;
      if (active.state === 'running') return;
      try {
        await active.resume();
      } catch {
        // Still suspended. The UI keeps the "tap to enable sound" affordance.
      }
    },

    isUnlocked(): boolean {
      // Deliberately does **not** call `ensureContext()`.
      //
      // A predicate that constructs an AudioContext as a side effect means
      // merely *asking* whether audio works can take a lock on the platform's
      // audio stack — and on a machine whose audio subsystem is unhappy,
      // `new AudioContext()` can block the main thread rather than throwing.
      // A read is a read. If no context has been created yet, the honest answer
      // is "not unlocked", which is also the true one.
      return ctx !== null && ctx.state === 'running';
    },

    enqueue(audio: ArrayBuffer): Promise<void> {
      const active = ensureContext();
      if (active === null) return Promise.resolve();

      const token = generation;
      inflight += 1;

      // Decode concurrently but schedule serially. Chaining the decodes as well
      // would make every chunk wait for the previous one to finish decoding,
      // which is latency spent for no ordering benefit.
      const decoded = active
        .decodeAudioData(audio)
        .then((buffer) => buffer)
        .catch(() => null);

      const scheduled = tail.then(async () => {
        try {
          const buffer = await decoded;
          if (buffer === null || token !== generation) return;
          schedule(active, buffer);
        } finally {
          inflight -= 1;
          drained();
        }
      });

      tail = scheduled.catch(() => undefined);
      return scheduled;
    },

    flush(): void {
      // Synchronous from top to bottom. This is R-22's entire implementation.
      generation += 1;
      cursor = 0;
      for (const source of live) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // Never started, or already stopped. Either way it is silent.
        }
        try {
          source.disconnect();
        } catch {
          // Already detached.
        }
        source.buffer = null;
      }
      live.clear();
      // No `onEnded` here: flush is an interruption, not completion, and the
      // caller that flushed already knows the queue is empty.
      playing = false;
    },

    isPlaying(): boolean {
      return live.size > 0 || inflight > 0;
    },

    onEnded(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    nativeContext(): AudioContext | null {
      return owned;
    },
  };
}
