/**
 * T-042 — endpointing, and the composition in T-049.
 *
 * t0 is defined by this file. Everything in the latency budget (plan §12.5) is
 * measured from the moment `onEndOfSpeech` fires, so "once per turn, at the
 * right millisecond" is not a nicety — a double fire double-counts a turn, and a
 * late fire makes every published number wrong by the same amount.
 *
 * The endpointer takes its clock as an argument, so every case here drives a
 * simulated second in whatever steps the case needs and asserts the fire count
 * directly. No timers, no sleeping, no flake.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LISTENING } from '../../src/config/settings.js';
import {
  createEndpointer,
  createSpeechInput,
  createUnsupportedInput,
  isProbablyIos,
  withEndpointing,
} from '../../src/speech/asr/index.js';
import type { SpeechInput, SpeechInputHandlers, TranscriptEvent } from '../../src/agent/ports.js';

const SILENCE = LISTENING.endpointSilenceMs;

function interim(text: string): TranscriptEvent {
  return { text, isFinal: false };
}

function final(text: string): TranscriptEvent {
  return { text, isFinal: true };
}

function harness(silenceMs?: number): {
  readonly fired: string[];
  readonly point: ReturnType<typeof createEndpointer>;
} {
  const fired: string[] = [];
  const point = createEndpointer({
    ...(silenceMs === undefined ? {} : { silenceMs }),
    onEndOfSpeech: (text: string) => fired.push(text),
  });
  return { fired, point };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createEndpointer — silence', () => {
  it('fires once after the silence window', () => {
    const { fired, point } = harness();
    point.push(interim('table for two'), 0);
    point.tick(SILENCE - 1);
    expect(fired).toEqual([]);
    point.tick(SILENCE);
    expect(fired).toEqual(['table for two']);
  });

  it('does not fire before the window closes', () => {
    const { fired, point } = harness();
    point.push(interim('hello'), 100);
    for (let t = 100; t < 100 + SILENCE; t += 50) point.tick(t);
    expect(fired).toEqual([]);
  });

  it('stays silent while ticking with no events at all', () => {
    const { fired, point } = harness();
    for (let t = 0; t < 5_000; t += 50) point.tick(t);
    expect(fired).toEqual([]);
  });

  it('does not start the window on an empty interim', () => {
    // A recogniser that is merely open emits empty interims. Nobody spoke, so
    // there is no turn to end.
    const { fired, point } = harness();
    point.push(interim(''), 0);
    point.push(interim('   '), 10);
    point.tick(SILENCE * 3);
    expect(fired).toEqual([]);
  });

  it('a late interim inside the window postpones the fire', () => {
    const { fired, point } = harness();
    point.push(interim('a table'), 0);
    point.tick(SILENCE - 100);
    point.push(interim('a table for four'), SILENCE - 100);
    point.tick(SILENCE);
    expect(fired).toEqual([]);
    point.tick(SILENCE - 100 + SILENCE);
    expect(fired).toEqual(['a table for four']);
  });

  it('survives a long sequence of interims and fires exactly once', () => {
    const { fired, point } = harness();
    for (let t = 0; t < 3_000; t += 200) point.push(interim(`word ${String(t)}`), t);
    for (let t = 3_000; t < 6_000; t += 50) point.tick(t);
    expect(fired).toEqual(['word 2800']);
  });

  it('trims the text it reports', () => {
    const { fired, point } = harness();
    point.push(interim('  eight o clock  '), 0);
    point.tick(SILENCE);
    expect(fired).toEqual(['eight o clock']);
  });

  it('honours an injected silence window', () => {
    const { fired, point } = harness(50);
    point.push(interim('yes'), 0);
    point.tick(49);
    expect(fired).toEqual([]);
    point.tick(50);
    expect(fired).toEqual(['yes']);
  });
});

describe('createEndpointer — finals', () => {
  it('fires immediately on a final result', () => {
    const { fired, point } = harness();
    point.push(final('yes that is right'), 0);
    expect(fired).toEqual(['yes that is right']);
  });

  it('a final beats the silence window when it arrives first', () => {
    const { fired, point } = harness();
    point.push(interim('seven'), 0);
    point.tick(100);
    point.push(final('seven thirty'), 200);
    expect(fired).toEqual(['seven thirty']);
    point.tick(5_000);
    expect(fired).toHaveLength(1);
  });

  it('an empty final still ends the turn, reporting the last interim', () => {
    const { fired, point } = harness();
    point.push(interim('four people'), 0);
    point.push(final(''), 100);
    expect(fired).toEqual(['four people']);
  });
});

describe('createEndpointer — once per turn', () => {
  it('does not fire twice for one turn', () => {
    const { fired, point } = harness();
    point.push(interim('hello'), 0);
    for (let t = SILENCE; t < 10_000; t += 50) point.tick(t);
    expect(fired).toHaveLength(1);
  });

  it('ignores a final that arrives after a silence fire', () => {
    const { fired, point } = harness();
    point.push(interim('hello'), 0);
    point.tick(SILENCE);
    point.push(final('hello there'), SILENCE + 10);
    expect(fired).toEqual(['hello']);
  });

  it('ignores interims that arrive after the turn has ended', () => {
    const { fired, point } = harness();
    point.push(final('done'), 0);
    point.push(interim('more words'), 10);
    point.tick(10 + SILENCE);
    expect(fired).toEqual(['done']);
  });
});

describe('createEndpointer — turn boundaries', () => {
  it('reset() re-arms for the next turn', () => {
    const { fired, point } = harness();
    point.push(final('first'), 0);
    point.reset();
    point.push(interim('second'), 100);
    point.tick(100 + SILENCE);
    expect(fired).toEqual(['first', 'second']);
  });

  it('reset() cancels a pending fire', () => {
    const { fired, point } = harness();
    point.push(interim('half a sentence'), 0);
    point.tick(SILENCE - 10);
    point.reset();
    point.tick(SILENCE);
    point.tick(SILENCE * 4);
    expect(fired).toEqual([]);
  });

  it('reset() drops the accumulated text', () => {
    const { fired, point } = harness();
    point.push(interim('stale'), 0);
    point.reset();
    point.push(final(''), 10);
    expect(fired).toEqual(['']);
  });

  it('isPending() tracks the window', () => {
    const { point } = harness();
    expect(point.isPending()).toBe(false);
    point.push(interim('mid sentence'), 0);
    expect(point.isPending()).toBe(true);
    point.tick(SILENCE);
    expect(point.isPending()).toBe(false);
  });

  it('runs three turns back to back with one fire each', () => {
    const { fired, point } = harness();
    for (const [index, word] of ['one', 'two', 'three'].entries()) {
      point.reset();
      const base = index * 10_000;
      point.push(interim(word), base);
      for (let t = base; t < base + 3_000; t += 50) point.tick(t);
    }
    expect(fired).toEqual(['one', 'two', 'three']);
  });
});

/* ------------------------------------------------------------ composition -- */

interface StubInput extends SpeechInput {
  emit(event: TranscriptEvent): void;
  readonly muteCalls: boolean[];
  stopped: boolean;
}

function createStubInput(kind: SpeechInput['kind'] = 'webspeech', available = true): StubInput {
  let handlers: SpeechInputHandlers | null = null;
  const muteCalls: boolean[] = [];
  return {
    kind,
    muteCalls,
    stopped: false,
    isAvailable: () => Promise.resolve(available),
    start(next: SpeechInputHandlers): Promise<void> {
      handlers = next;
      return Promise.resolve();
    },
    stop(): void {
      this.stopped = true;
    },
    setMuted(muted: boolean): void {
      muteCalls.push(muted);
    },
    level: () => 0.25,
    emit(event: TranscriptEvent): void {
      handlers?.onTranscript(event);
    },
  };
}

describe('withEndpointing', () => {
  it('drives end-of-speech from the endpointer, not the recogniser', async () => {
    vi.useFakeTimers();
    const inner = createStubInput();
    let clock = 0;
    const fired: string[] = [];
    const composed = withEndpointing(inner, { tickMs: 10, now: () => clock });

    await composed.start({
      onTranscript: () => undefined,
      onEndOfSpeech: (text: string) => fired.push(text),
      onError: () => undefined,
    });

    inner.emit(interim('a table please'));
    clock = SILENCE;
    await vi.advanceTimersByTimeAsync(20);

    expect(fired).toEqual(['a table please']);
    composed.stop();
    expect(inner.stopped).toBe(true);
  });

  it('re-arms on unmute, which is what starting to listen looks like', async () => {
    vi.useFakeTimers();
    const inner = createStubInput();
    const clock = 0;
    const fired: string[] = [];
    const composed = withEndpointing(inner, { tickMs: 10, now: () => clock });
    await composed.start({
      onTranscript: () => undefined,
      onEndOfSpeech: (text: string) => fired.push(text),
      onError: () => undefined,
    });

    inner.emit(final('first turn'));
    composed.setMuted(true);
    composed.setMuted(false);
    inner.emit(final('second turn'));

    expect(fired).toEqual(['first turn', 'second turn']);
    expect(inner.muteCalls).toEqual([true, false]);
    composed.stop();
  });

  it('passes level and kind through untouched', async () => {
    const inner = createStubInput('hosted');
    const composed = withEndpointing(inner);
    expect(composed.kind).toBe('hosted');
    expect(composed.level()).toBe(0.25);
    await expect(composed.isAvailable()).resolves.toBe(true);
  });
});

describe('createSpeechInput', () => {
  it('takes the injected Web Speech adapter when it is available', async () => {
    const input = await createSpeechInput({ webspeech: createStubInput('webspeech') });
    expect(input.kind).toBe('webspeech');
  });

  it('prefers the hosted adapter on iOS', async () => {
    const input = await createSpeechInput({
      preferHosted: true,
      hosted: createStubInput('hosted'),
      webspeech: createStubInput('webspeech'),
    });
    expect(input.kind).toBe('hosted');
  });

  it('falls back to hosted when Web Speech reports unavailable', async () => {
    const input = await createSpeechInput({
      webspeech: createStubInput('webspeech', false),
      hosted: createStubInput('hosted'),
    });
    expect(input.kind).toBe('hosted');
  });

  it('degrades to an input that explains itself when nothing is available', async () => {
    // No Web Speech and no hosted adapter injected. Hosted recognition needs a
    // configured gateway client, which only the composition root can supply, so
    // "not passed in" and "not available" are the same thing here.
    const input = await createSpeechInput({ webspeech: createStubInput('webspeech', false) });
    expect(input.kind).toBe('none');

    const errors: string[] = [];
    await input.start({
      onTranscript: () => undefined,
      onEndOfSpeech: () => undefined,
      onError: (error) => errors.push(error.kind),
    });
    expect(errors).toEqual(['not_supported']);
    input.stop();
  });

  it('refuses a hosted adapter that reports itself unavailable', async () => {
    // The case that matters: a site built without a gateway URL. The hosted
    // adapter exists as an object but cannot work, and choosing it would strand
    // a Firefox visitor instead of offering them typing (plan §7.5 F8).
    const input = await createSpeechInput({
      webspeech: createStubInput('webspeech', false),
      hosted: createStubInput('hosted', false),
    });
    expect(input.kind).toBe('none');
  });

  it('uses an available hosted adapter when Web Speech is missing', async () => {
    const input = await createSpeechInput({
      webspeech: createStubInput('webspeech', false),
      hosted: createStubInput('hosted', true),
    });
    expect(input.kind).toBe('hosted');
  });
});

describe('createUnsupportedInput', () => {
  it('never throws and reports not_supported', async () => {
    const input = createUnsupportedInput();
    await expect(input.isAvailable()).resolves.toBe(false);
    expect(input.level()).toBe(0);
    expect(() => input.setMuted(true)).not.toThrow();
    expect(() => input.stop()).not.toThrow();
  });
});

describe('isProbablyIos', () => {
  it('is false where there is no navigator at all', () => {
    // The `node` test environment. Detection has to survive that, because the
    // same module is imported by scripts that never run in a browser.
    expect(isProbablyIos()).toBe(false);
  });
});
