/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * `/speak` (T-064).
 *
 * These call {@link handleSpeak} directly rather than through the router. The
 * router imports `./chat.js` and `./listen.js`, which are being written under
 * separate tasks; testing the handler in isolation keeps this suite green
 * regardless of what state its siblings are in, and the handler's contract with
 * the router is one exported function with a fixed signature.
 *
 * The provider is stubbed with a hand-built `ReadableStream` throughout. The
 * suite never makes a network call and never needs a real key — the key that
 * appears below is the fake one bound in `vitest.config.ts`, and one test
 * exists purely to prove it does not come back out.
 */

import { env as providedEnv } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { estimateSeconds, handleSpeak } from '../src/speak.js';
import type { Env, SessionClaims } from '../src/types.js';

/**
 * `cloudflare:test` types its `env` from an ambient `ProvidedEnv` interface that
 * projects normally widen by module augmentation. An augmentation that only
 * extends `Env` declares no members of its own, which the shared lint config
 * rejects, so the bindings are narrowed here instead. Same effect, one line.
 */
const env = providedEnv as unknown as Env;

/**
 * The slice of a `fetch` init this suite inspects.
 *
 * Spelled out rather than using `RequestInit`, which is a type-only global that
 * the repository's lint config does not know about.
 */
interface FetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal | null;
}

/* ------------------------------------------------------------- fixtures -- */

// Fresh arrays each time: handing a `Uint8Array` to `Response` or to a stream
// controller detaches its buffer, so a shared constant survives exactly one use.
const MAGIC = [0x4f, 0x67, 0x67, 0x53];
const TAIL = [0x01, 0x02, 0x03];
const oggMagic = (): Uint8Array => new Uint8Array(MAGIC);

let sidCounter = 0;

/** A fresh session id per test, so one test's spend never lands on another. */
function claimsFor(ttsSeconds = 90): SessionClaims {
  sidCounter += 1;
  const now = Math.floor(Date.now() / 1000);
  return {
    sid: `test-sid-${String(sidCounter)}`,
    iat: now,
    exp: now + 1200,
    quota: { turns: 12, ttsSeconds, clips: 25 },
  };
}

function speakRequest(body: unknown, signal?: AbortSignal): Request {
  const init: FetchInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
  const request = new Request('https://gateway.test/speak', init);
  // workerd builds its own signal for a constructed Request and ignores the one
  // in the init, so an abort test has to install the signal it wants to fire.
  if (signal !== undefined) Object.defineProperty(request, 'signal', { value: signal, configurable: true });
  return request;
}

type FetchImpl = (input: unknown, init: FetchInit) => Promise<Response> | Response;

/** Replace global fetch and record what the adapter sent upstream. */
function stubProvider(impl: FetchImpl): FetchInit[] {
  const calls: FetchInit[] = [];
  vi.stubGlobal('fetch', (input: unknown, init?: FetchInit): Promise<Response> => {
    const seen = init ?? {};
    calls.push(seen);
    return Promise.resolve(impl(input, seen));
  });
  return calls;
}

interface UpstreamBody {
  readonly model?: unknown;
  readonly voice?: unknown;
  readonly input?: unknown;
  readonly response_format?: unknown;
}

function upstreamBody(init: FetchInit): UpstreamBody {
  return JSON.parse(String(init.body)) as UpstreamBody;
}

function errorBody(response: Response): Promise<{ code?: unknown; retryable?: unknown; error?: unknown }> {
  return response.json();
}

async function spentSeconds(sid: string): Promise<number> {
  const raw = await env.STATE.get(`spend:${sid}`);
  if (raw === null) return 0;
  const record = JSON.parse(raw) as { ttsSeconds?: unknown };
  return typeof record.ttsSeconds === 'number' ? record.ttsSeconds : 0;
}

/** One chunk now, the rest only when the test says so. */
function pausedAudioStream(): { stream: ReadableStream<Uint8Array>; finished: () => boolean; finish: () => void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let done = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c): void {
      controller = c;
      c.enqueue(oggMagic());
    },
  });
  return {
    stream,
    finished: (): boolean => done,
    finish: (): void => {
      controller?.enqueue(new Uint8Array(TAIL));
      controller?.close();
      done = true;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------- the tests -- */

describe('POST /speak', () => {
  it('streams the provider audio back as audio/ogg, uncached', async () => {
    stubProvider(() => new Response(oggMagic(), { status: 200 }));

    const response = await handleSpeak(speakRequest({ text: 'Table for two at seven.' }), env, claimsFor());

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('audio/ogg');
    // The clip contains the visitor's name; nothing may cache it.
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(MAGIC);
  });

  it('resolves before the provider has finished emitting', async () => {
    // The load-bearing latency test. If the handler ever buffers, it can only
    // resolve after `finish()` has run, and this fails.
    const paused = pausedAudioStream();
    stubProvider(() => new Response(paused.stream, { status: 200 }));

    const response = await handleSpeak(speakRequest({ text: 'Right away.' }), env, claimsFor());

    expect(response.status).toBe(200);
    expect(paused.finished()).toBe(false);

    paused.finish();
    const bytes = [...new Uint8Array(await response.arrayBuffer())];
    expect(bytes).toEqual([...MAGIC, ...TAIL]);
  });

  it('rejects text over the 240-character cap with 413', async () => {
    const calls = stubProvider(() => new Response(oggMagic()));

    const response = await handleSpeak(speakRequest({ text: 'a'.repeat(241) }), env, claimsFor());

    expect(response.status).toBe(413);
    const body = await errorBody(response);
    expect(body.code).toBe('text_too_long');
    expect(body.retryable).toBe(false);
    // Nothing reached the provider, and nothing was charged.
    expect(calls).toHaveLength(0);
  });

  it('accepts text of exactly 240 characters', async () => {
    stubProvider(() => new Response(oggMagic()));

    const response = await handleSpeak(speakRequest({ text: 'a'.repeat(240) }), env, claimsFor());

    expect(response.status).toBe(200);
  });

  it('rejects empty text with 400', async () => {
    const response = await handleSpeak(speakRequest({ text: '   ' }), env, claimsFor());

    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe('bad_request');
  });

  it('rejects non-string text with 400', async () => {
    const response = await handleSpeak(speakRequest({ text: { toString: 'no' } }), env, claimsFor());

    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe('bad_request');
  });

  it('rejects a body that is not JSON with 400', async () => {
    const response = await handleSpeak(speakRequest('this is not json'), env, claimsFor());

    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe('bad_request');
  });

  it('rejects a format other than opus with 400', async () => {
    const response = await handleSpeak(speakRequest({ text: 'Hello.', format: 'mp3' }), env, claimsFor());

    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe('bad_request');
  });

  it('charges the seconds estimate against the session quota', async () => {
    stubProvider(() => new Response(oggMagic()));
    const claims = claimsFor();

    // 42 characters at 14 per second, rounded up.
    const response = await handleSpeak(speakRequest({ text: 'a'.repeat(42) }), env, claims);

    expect(response.status).toBe(200);
    expect(await spentSeconds(claims.sid)).toBe(3);
    expect(estimateSeconds('a'.repeat(42))).toBe(3);
  });

  it('charges a long line more than a short one', async () => {
    stubProvider(() => new Response(oggMagic()));
    const shortClaims = claimsFor();
    const longClaims = claimsFor();

    await handleSpeak(speakRequest({ text: 'Yes.' }), env, shortClaims);
    await handleSpeak(speakRequest({ text: 'a'.repeat(200) }), env, longClaims);

    const cheap = await spentSeconds(shortClaims.sid);
    const dear = await spentSeconds(longClaims.sid);
    expect(cheap).toBe(1);
    expect(dear).toBe(15);
    expect(dear).toBeGreaterThan(cheap);
  });

  it('returns 429 session_tts_exhausted when the quota will not cover the line', async () => {
    const calls = stubProvider(() => new Response(oggMagic()));

    // Two seconds left, a line that estimates at three.
    const response = await handleSpeak(speakRequest({ text: 'a'.repeat(42) }), env, claimsFor(2));

    expect(response.status).toBe(429);
    const body = await errorBody(response);
    expect(body.code).toBe('session_tts_exhausted');
    // Nothing to retry towards: the client already has browser speech.
    expect(body.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('maps a provider 429 to 429 provider_rate_limited', async () => {
    stubProvider(() => new Response('{"error":"rate limited"}', { status: 429 }));

    const response = await handleSpeak(speakRequest({ text: 'Hello.' }), env, claimsFor());

    expect(response.status).toBe(429);
    const body = await errorBody(response);
    expect(body.code).toBe('provider_rate_limited');
    expect(body.retryable).toBe(true);
  });

  it('maps a provider 500 to 503 provider_unavailable', async () => {
    stubProvider(() => new Response('boom', { status: 500 }));

    const response = await handleSpeak(speakRequest({ text: 'Hello.' }), env, claimsFor());

    expect(response.status).toBe(503);
    const body = await errorBody(response);
    expect(body.code).toBe('provider_unavailable');
    expect(body.retryable).toBe(true);
  });

  it('maps an unreachable provider to 503 provider_unavailable', async () => {
    stubProvider(() => Promise.reject(new TypeError('network failure')));

    const response = await handleSpeak(speakRequest({ text: 'Hello.' }), env, claimsFor());

    expect(response.status).toBe(503);
    expect((await errorBody(response)).code).toBe('provider_unavailable');
  });

  it('maps a provider timeout to 504 provider_timeout', async () => {
    // This is exactly what the handler's own eight-second deadline raises on
    // the fetch it aborts, so stubbing it here tests the real mapping.
    stubProvider(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));

    const response = await handleSpeak(speakRequest({ text: 'Hello.' }), env, claimsFor());

    expect(response.status).toBe(504);
    const body = await errorBody(response);
    expect(body.code).toBe('provider_timeout');
    expect(body.retryable).toBe(true);
  });

  it('maps another provider 4xx to 502 provider_rejected', async () => {
    stubProvider(() => new Response('{"error":"unknown model"}', { status: 400 }));

    const response = await handleSpeak(speakRequest({ text: 'Hello.' }), env, claimsFor());

    expect(response.status).toBe(502);
    const body = await errorBody(response);
    expect(body.code).toBe('provider_rejected');
    // Retrying reproduces it exactly; this one needs the operator.
    expect(body.retryable).toBe(false);
  });

  it('takes the model and voice from the env bindings', async () => {
    const calls = stubProvider(() => new Response(oggMagic()));

    await handleSpeak(speakRequest({ text: 'Seven o clock, then.' }), env, claimsFor());

    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (call === undefined) throw new Error('no upstream call');
    const sent = upstreamBody(call);
    expect(sent.model).toBe(env.TTS_MODEL);
    expect(sent.voice).toBe(env.TTS_VOICE);
    expect(sent.input).toBe('Seven o clock, then.');
    expect(sent.response_format).toBe('opus');
  });

  it('ignores a client-supplied voice', async () => {
    const calls = stubProvider(() => new Response(oggMagic()));

    await handleSpeak(
      speakRequest({ text: 'Hello.', voice: '../../models/something-expensive' }),
      env,
      claimsFor(),
    );

    const [call] = calls;
    if (call === undefined) throw new Error('no upstream call');
    const sent = upstreamBody(call);
    // Policy: the binding always wins. The field is accepted for §11 shape
    // compatibility and then discarded.
    expect(sent.voice).toBe(env.TTS_VOICE);
    expect(sent.model).toBe(env.TTS_MODEL);
  });

  it('never puts the provider key in a response', async () => {
    const key = env.TTS_API_KEY;
    expect(key).not.toBe('');

    // A provider that echoes the Authorization header back, in both a header
    // and an error body. Neither may survive the hop to the browser.
    stubProvider(
      () =>
        new Response(`{"error":"bad key Bearer ${key}"}`, {
          status: 401,
          headers: { 'X-Echoed-Auth': `Bearer ${key}`, 'Set-Cookie': `k=${key}` },
        }),
    );

    const failed = await handleSpeak(speakRequest({ text: 'Hello.' }), env, claimsFor());
    expect(failed.status).toBe(502);
    expect(JSON.stringify([...failed.headers])).not.toContain(key);
    expect(await failed.text()).not.toContain(key);

    stubProvider(
      () => new Response(oggMagic(), { status: 200, headers: { 'X-Echoed-Auth': `Bearer ${key}` } }),
    );
    const ok = await handleSpeak(speakRequest({ text: 'Hello.' }), env, claimsFor());
    expect(ok.status).toBe(200);
    expect(JSON.stringify([...ok.headers])).not.toContain(key);
    expect(ok.headers.get('X-Echoed-Auth')).toBeNull();
  });

  it('sends the key upstream as a bearer token', async () => {
    const calls = stubProvider(() => new Response(oggMagic()));

    await handleSpeak(speakRequest({ text: 'Hello.' }), env, claimsFor());

    const [call] = calls;
    if (call === undefined) throw new Error('no upstream call');
    const headers = new Headers(call.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${env.TTS_API_KEY}`);
  });

  it('propagates an abort on the incoming request to the provider fetch', async () => {
    let upstreamSignal: AbortSignal | undefined;
    // A provider that never answers, so the only thing that can end the request
    // is the abort travelling from the incoming request to this fetch.
    vi.stubGlobal('fetch', (_input: unknown, init?: FetchInit): Promise<Response> => {
      const signal = init?.signal ?? undefined;
      upstreamSignal = signal;
      return new Promise<Response>((_resolve, reject) => {
        const fail = (): void => {
          reject(new DOMException('aborted', 'AbortError'));
        };
        if (signal === undefined || signal.aborted) fail();
        else signal.addEventListener('abort', fail);
      });
    });

    const controller = new AbortController();
    const pending = handleSpeak(
      speakRequest({ text: 'The agent was mid-sentence.' }, controller.signal),
      env,
      claimsFor(),
    );

    // Let the handler get as far as the provider before interrupting, so the
    // abort has to travel rather than being observed as already-set.
    for (let i = 0; i < 100 && upstreamSignal === undefined; i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1);
      });
    }
    expect(upstreamSignal).toBeDefined();
    expect(upstreamSignal?.aborted).toBe(false);

    // Barge-in: the visitor talks over the line being synthesised (T-085).
    controller.abort();
    const response = await pending;

    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.status).toBe(499);
  });
});

describe('estimateSeconds', () => {
  it('rounds up and never charges less than a second', () => {
    expect(estimateSeconds('hi')).toBe(1);
    expect(estimateSeconds('a'.repeat(14))).toBe(1);
    expect(estimateSeconds('a'.repeat(15))).toBe(2);
    // The 240-character cap is worth 18 seconds of a 90-second budget, so a
    // session gets at least five full-length lines.
    expect(estimateSeconds('a'.repeat(240))).toBe(18);
  });
});
