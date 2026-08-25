/**
 * The speech cascade (T-082), and one bug it is here to stop coming back.
 *
 * `SpeechCascade` used to have `speakOrResolve` but no `speak`. The orchestrator
 * calls `speech.speak?.(…)` — optionally, because the prebaked and hosted rungs
 * genuinely have no such method — so the missing one was simply `undefined` and
 * the call did nothing. The result: **in the default build, with no gateway and
 * no baked clips, the agent had no voice at all**, and nothing anywhere
 * reported a problem.
 *
 * That is the failure mode worth testing for. A rung that throws gets noticed;
 * a rung that silently does nothing does not. So these tests assert the
 * *observable outcome* — that words reach a speaker — rather than that a method
 * exists.
 */

import { describe, expect, it, vi } from 'vitest';

import { SpeechCascade } from '../../src/speech/tts/index.js';
import type { PrebakedSpeech, HostedSpeech } from '../../src/speech/tts/index.js';
import type { BrowserSpeechOutput } from '../../src/speech/tts/browser.js';
import type { SpeechClip, SpeechRequest } from '../../src/agent/ports.js';

const LINE: SpeechRequest = { text: 'Which day were you thinking?', locale: 'en-IN' };

/** The browser rung: owns its own output device, so it returns no buffer. */
function fakeBrowser(): BrowserSpeechOutput & { spoken: string[] } {
  const spoken: string[] = [];
  return {
    kind: 'browser',
    spoken,
    async resolve(): Promise<SpeechClip> {
      return { source: 'browser', audio: null, resolvedInMs: 1 };
    },
    async speak(request: SpeechRequest): Promise<void> {
      spoken.push(request.text);
    },
    cancel: () => undefined,
  } as unknown as BrowserSpeechOutput & { spoken: string[] };
}

function fakeHosted(behaviour: 'ok' | 'fail'): HostedSpeech {
  return {
    kind: 'hosted',
    async resolve(): Promise<SpeechClip> {
      if (behaviour === 'fail') throw new Error('provider down');
      return { source: 'hosted', audio: new ArrayBuffer(8), resolvedInMs: 40 };
    },
    cancel: () => undefined,
  } as unknown as HostedSpeech;
}

function fakePrebaked(behaviour: 'hit' | 'miss'): PrebakedSpeech {
  return {
    kind: 'prebaked',
    async warm(): Promise<void> {
      return undefined;
    },
    async resolve(): Promise<SpeechClip> {
      if (behaviour === 'miss') throw new Error('no baked clip');
      return { source: 'prebaked', audio: new ArrayBuffer(4), resolvedInMs: 0 };
    },
    cancel: () => undefined,
  } as unknown as PrebakedSpeech;
}

describe('the default build actually speaks', () => {
  it('reaches the browser voice when nothing else is configured', async () => {
    // The shipped state: no gateway URL, so no hosted rung, and no baked audio
    // because the operator has not run the bake script. If this fails, the demo
    // is silent for every visitor and no error says so.
    const browser = fakeBrowser();
    const cascade = new SpeechCascade({ browser });

    const clip = await cascade.resolve(LINE);
    expect(clip.source).toBe('browser');
    expect(clip.audio).toBeNull();

    await cascade.speak(LINE);
    expect(browser.spoken).toEqual([LINE.text]);
  });

  it('exposes `speak`, because the orchestrator calls it optionally', () => {
    // The bug in one assertion. `speech.speak?.(…)` cannot distinguish "this
    // adapter has no speak" from "this adapter did nothing", so the cascade —
    // which can always end on the browser — must have one.
    const cascade = new SpeechCascade({ browser: fakeBrowser() });
    expect(typeof cascade.speak).toBe('function');
  });

  it('speakOrResolve gets the words out in one call', async () => {
    const browser = fakeBrowser();
    const cascade = new SpeechCascade({ browser });

    const clip = await cascade.speakOrResolve(LINE);
    expect(clip.source).toBe('browser');
    expect(browser.spoken).toEqual([LINE.text]);
  });

  it('does not call the browser voice when a rung above returned audio', async () => {
    const browser = fakeBrowser();
    const cascade = new SpeechCascade({ prebaked: fakePrebaked('hit'), browser });

    // A phrase key is what makes a line *bakeable* — without one there is no
    // manifest entry to look up, so the prebaked rung is correctly skipped.
    const clip = await cascade.speakOrResolve({ ...LINE, phraseKey: 'ask_date', variant: 0 });
    expect(clip.source).toBe('prebaked');
    expect(clip.audio).not.toBeNull();
    expect(browser.spoken).toEqual([]);
  });
});

describe('the cascade order', () => {
  it('prefers a baked clip, which costs no synthesis at all', async () => {
    const onSource = vi.fn();
    const cascade = new SpeechCascade({
      prebaked: fakePrebaked('hit'),
      hosted: fakeHosted('ok'),
      browser: fakeBrowser(),
      onSource,
    });

    const clip = await cascade.resolve({ ...LINE, phraseKey: 'ask_date', variant: 0 });
    expect(clip.source).toBe('prebaked');
    expect(onSource).toHaveBeenCalledWith('prebaked', expect.any(Number));
  });

  it('falls to hosted on a cache miss', async () => {
    const cascade = new SpeechCascade({
      prebaked: fakePrebaked('miss'),
      hosted: fakeHosted('ok'),
      browser: fakeBrowser(),
    });

    expect((await cascade.resolve(LINE)).source).toBe('hosted');
  });

  it('falls to the browser when hosted fails, and does not try hosted again', async () => {
    // A rung is skipped, never retried. A hosted request that failed once this
    // session is unlikely to succeed on the next line, and spending another two
    // seconds finding out is exactly the dead air R-23 forbids.
    const hosted = fakeHosted('fail');
    const resolve = vi.spyOn(hosted, 'resolve');
    const browser = fakeBrowser();
    const cascade = new SpeechCascade({ hosted, browser });

    expect((await cascade.resolve(LINE)).source).toBe('browser');
    expect(cascade.hostedAvailable).toBe(false);

    expect((await cascade.resolve(LINE)).source).toBe('browser');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('does not write the hosted rung off because the visitor interrupted', async () => {
    // An abort is a barge-in, not a provider failure. Confusing the two would
    // cost the neural voice for the rest of the visit every time someone talked
    // over the agent — which they are encouraged to do.
    const hosted = fakeHosted('ok');
    vi.spyOn(hosted, 'resolve').mockRejectedValue(new Error('aborted'));
    const cascade = new SpeechCascade({ hosted, browser: fakeBrowser() });

    const controller = new AbortController();
    controller.abort();

    await expect(cascade.resolve(LINE, controller.signal)).rejects.toThrow();
    expect(cascade.hostedAvailable).toBe(true);
  });

  it('throws only when there is no rung left at all', async () => {
    const cascade = new SpeechCascade({});
    await expect(cascade.resolve(LINE)).rejects.toThrow(/no speech output/);
  });
});
