/**
 * T-043 — the interruptible audio queue.
 *
 * The assertion that matters is the one about `flush()`: it counts `stop()`
 * calls on the fake sources on the line immediately after `flush()` returns,
 * with no `await` in between. R-22 gives the whole barge-in path 150ms and an
 * `await` anywhere in `flush` would spend most of it, so "synchronous" is
 * checked as a property of the call rather than measured with a timer.
 *
 * The context is a hand-written fake. A real `AudioContext` does not exist under
 * the `node` test environment, and `src/speech/audio.ts` was written against a
 * structural interface precisely so this file could supply one in twenty lines.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAudioQueue } from '../../src/speech/audio.js';
import type { AudioBufferLike, AudioContextLike, AudioSourceLike } from '../../src/speech/audio.js';

interface FakeSource extends AudioSourceLike {
  readonly starts: number[];
  stops: number;
  disconnects: number;
  connectedTo: unknown;
  end(): void;
}

interface FakeContext extends AudioContextLike {
  currentTime: number;
  state: string;
  readonly sources: FakeSource[];
  resumes: number;
  /** Resolves the pending decode for a chunk of `bytes` length after `delayMs`. */
  decodeDelayFor(bytes: number, delayMs: number): void;
}

function createFakeContext(): FakeContext {
  const sources: FakeSource[] = [];
  const delays = new Map<number, number>();

  const context: FakeContext = {
    currentTime: 0,
    state: 'suspended',
    destination: { id: 'destination' },
    sources,
    resumes: 0,

    decodeDelayFor(bytes: number, delayMs: number): void {
      delays.set(bytes, delayMs);
    },

    decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
      // One byte of input is one second of audio. Arbitrary, and it makes the
      // scheduling arithmetic readable in the assertions.
      const buffer: AudioBufferLike = { duration: data.byteLength };
      const delay = delays.get(data.byteLength);
      if (delay === undefined) return Promise.resolve(buffer);
      return new Promise((done) => setTimeout(() => done(buffer), delay));
    },

    createBufferSource(): AudioSourceLike {
      const source: FakeSource = {
        buffer: null,
        onended: null,
        starts: [],
        stops: 0,
        disconnects: 0,
        connectedTo: null,
        connect(destination: unknown): void {
          source.connectedTo = destination;
        },
        disconnect(): void {
          source.disconnects += 1;
        },
        start(when?: number): void {
          source.starts.push(when ?? 0);
        },
        stop(): void {
          source.stops += 1;
        },
        end(): void {
          source.onended?.();
        },
      };
      sources.push(source);
      return source;
    },

    resume(): Promise<void> {
      context.resumes += 1;
      context.state = 'running';
      return Promise.resolve();
    },
  };

  return context;
}

/** An ArrayBuffer whose length is the chunk's duration in the fake. */
function chunk(seconds: number): ArrayBuffer {
  return new ArrayBuffer(seconds);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createAudioQueue — scheduling', () => {
  it('decodes a chunk and starts it at the context clock', async () => {
    const context = createFakeContext();
    context.currentTime = 4;
    const queue = createAudioQueue(context);

    await queue.enqueue(chunk(2));

    expect(context.sources).toHaveLength(1);
    const source = context.sources[0];
    expect(source?.starts).toEqual([4]);
    expect(source?.buffer).toEqual({ duration: 2 });
    expect(source?.connectedTo).toBe(context.destination);
  });

  it('schedules consecutive chunks gapless against a running cursor', async () => {
    const context = createFakeContext();
    const queue = createAudioQueue(context);

    await queue.enqueue(chunk(3));
    await queue.enqueue(chunk(5));

    expect(context.sources[0]?.starts).toEqual([0]);
    expect(context.sources[1]?.starts).toEqual([3]);
  });

  it('never schedules in the past when the context clock has moved on', async () => {
    const context = createFakeContext();
    const queue = createAudioQueue(context);

    await queue.enqueue(chunk(1));
    context.currentTime = 9;
    await queue.enqueue(chunk(1));

    expect(context.sources[1]?.starts).toEqual([9]);
  });

  it('preserves order when a later chunk decodes first', async () => {
    vi.useFakeTimers();
    const context = createFakeContext();
    // The first chunk takes 100ms to decode; the second resolves immediately.
    context.decodeDelayFor(3, 100);
    const queue = createAudioQueue(context);

    const first = queue.enqueue(chunk(3));
    const second = queue.enqueue(chunk(5));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([first, second]);

    expect(context.sources).toHaveLength(2);
    expect(context.sources[0]?.buffer).toEqual({ duration: 3 });
    expect(context.sources[1]?.buffer).toEqual({ duration: 5 });
    expect(context.sources[1]?.starts).toEqual([3]);
  });

  it('swallows a decode failure rather than rejecting the caller', async () => {
    const context = createFakeContext();
    context.decodeAudioData = (): Promise<AudioBufferLike> => Promise.reject(new Error('bad audio'));
    const queue = createAudioQueue(context);

    await expect(queue.enqueue(chunk(1))).resolves.toBeUndefined();
    expect(context.sources).toHaveLength(0);
  });
});

describe('createAudioQueue — flush', () => {
  it('stops every live source synchronously', async () => {
    const context = createFakeContext();
    const queue = createAudioQueue(context);
    await queue.enqueue(chunk(2));
    await queue.enqueue(chunk(2));

    queue.flush();

    // No await between flush() and this line: R-22 is about the call, not the
    // eventual state.
    expect(context.sources.map((source) => source.stops)).toEqual([1, 1]);
    expect(context.sources.map((source) => source.disconnects)).toEqual([1, 1]);
    expect(context.sources.map((source) => source.buffer)).toEqual([null, null]);
    expect(queue.isPlaying()).toBe(false);
  });

  it('discards chunks whose decode was still in flight', async () => {
    vi.useFakeTimers();
    const context = createFakeContext();
    context.decodeDelayFor(7, 50);
    const queue = createAudioQueue(context);

    const inFlight = queue.enqueue(chunk(7));
    queue.flush();
    await vi.advanceTimersByTimeAsync(100);
    await inFlight;

    expect(context.sources).toHaveLength(0);
  });

  it('resets the cursor so the next chunk starts at the current time', async () => {
    const context = createFakeContext();
    const queue = createAudioQueue(context);
    await queue.enqueue(chunk(30));

    queue.flush();
    context.currentTime = 2;
    await queue.enqueue(chunk(1));

    expect(context.sources[1]?.starts).toEqual([2]);
  });

  it('does not fire onEnded, because an interruption is not completion', async () => {
    const context = createFakeContext();
    const queue = createAudioQueue(context);
    const ended = vi.fn();
    queue.onEnded(ended);
    await queue.enqueue(chunk(1));

    queue.flush();

    expect(ended).not.toHaveBeenCalled();
  });

  it('is safe on an empty queue', () => {
    const context = createFakeContext();
    const queue = createAudioQueue(context);
    expect(() => queue.flush()).not.toThrow();
  });
});

describe('createAudioQueue — unlock', () => {
  it('resumes a suspended context', async () => {
    const context = createFakeContext();
    const queue = createAudioQueue(context);

    await queue.unlock();

    expect(context.resumes).toBe(1);
    expect(context.state).toBe('running');
  });

  it('is idempotent once the context is running', async () => {
    const context = createFakeContext();
    const queue = createAudioQueue(context);

    await queue.unlock();
    await queue.unlock();
    await queue.unlock();

    expect(context.resumes).toBe(1);
  });

  it('does not throw when resume is refused', async () => {
    const context = createFakeContext();
    context.resume = (): Promise<void> => Promise.reject(new Error('blocked'));
    const queue = createAudioQueue(context);

    await expect(queue.unlock()).resolves.toBeUndefined();
  });
});

describe('createAudioQueue — drain and listeners', () => {
  it('fires onEnded once when the queue drains, not once per chunk', async () => {
    const context = createFakeContext();
    const queue = createAudioQueue(context);
    const ended = vi.fn();
    queue.onEnded(ended);

    await queue.enqueue(chunk(1));
    await queue.enqueue(chunk(1));
    expect(queue.isPlaying()).toBe(true);

    context.sources[0]?.end();
    expect(ended).not.toHaveBeenCalled();
    context.sources[1]?.end();

    expect(ended).toHaveBeenCalledTimes(1);
    expect(queue.isPlaying()).toBe(false);
  });

  it('releases the decoded buffer when a source ends', async () => {
    const context = createFakeContext();
    const queue = createAudioQueue(context);
    await queue.enqueue(chunk(1));

    context.sources[0]?.end();

    expect(context.sources[0]?.buffer).toBeNull();
    expect(context.sources[0]?.disconnects).toBe(1);
  });

  it('unsubscribes a listener', async () => {
    const context = createFakeContext();
    const queue = createAudioQueue(context);
    const ended = vi.fn();
    const off = queue.onEnded(ended);
    off();

    await queue.enqueue(chunk(1));
    context.sources[0]?.end();

    expect(ended).not.toHaveBeenCalled();
  });

  it('notifies every subscriber', async () => {
    const context = createFakeContext();
    const queue = createAudioQueue(context);
    const first = vi.fn();
    const second = vi.fn();
    queue.onEnded(first);
    queue.onEnded(second);

    await queue.enqueue(chunk(1));
    context.sources[0]?.end();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('createAudioQueue — no Web Audio', () => {
  it('degrades to a silent no-op instead of throwing', async () => {
    // The `node` environment has no AudioContext, which is exactly F11's
    // worst case and the reason nothing in this file may throw.
    const queue = createAudioQueue();

    await expect(queue.unlock()).resolves.toBeUndefined();
    await expect(queue.enqueue(chunk(1))).resolves.toBeUndefined();
    expect(() => queue.flush()).not.toThrow();
    expect(queue.isPlaying()).toBe(false);
    expect(queue.nativeContext()).toBeNull();
  });

  it('reports no native context when one was injected', () => {
    const queue = createAudioQueue(createFakeContext());
    expect(queue.nativeContext()).toBeNull();
  });
});
