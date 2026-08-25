/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * `/listen` — hosted recognition (T-065).
 *
 * The handler is exercised directly rather than through the router, because
 * what is under test here is the validation order and the error mapping, and
 * routing them is `index.ts`'s job with its own coverage.
 *
 * Two things get asserted repeatedly and deliberately: that an oversized upload
 * is refused before its body is touched, and that neither the STT key nor the
 * provider's extra payload fields can reach the client. Both are claims the
 * README makes, so both are tests rather than intentions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env as testEnv } from 'cloudflare:test';

import type { Env, SessionClaims, SessionQuota } from '../src/types.js';
import { DEFAULT_QUOTA, LIMITS } from '../src/types.js';
import { handleListen } from '../src/listen.js';

const env = testEnv as unknown as Env;
const encoder = new TextEncoder();
const BOUNDARY = 'hostlinetestboundary';

let sessionCounter = 0;

/** A fresh sid per test, so one test's spend never bleeds into another's. */
function claimsWith(quota: SessionQuota = DEFAULT_QUOTA): SessionClaims {
  sessionCounter += 1;
  return { sid: `test-session-${String(sessionCounter)}`, iat: 0, exp: 9_999_999_999, quota };
}

function clipBytes(size: number): Uint8Array {
  return new Uint8Array(size).fill(7);
}

/** The ordinary path: `FormData`, with the runtime setting the boundary. */
function formRequest(form: FormData, signal?: AbortSignal): Request {
  return new Request('https://gateway.test/listen', {
    method: 'POST',
    body: form,
    ...(signal === undefined ? {} : { signal }),
  });
}

function audioForm(options?: {
  readonly type?: string;
  readonly size?: number;
  readonly locale?: string;
}): FormData {
  const form = new FormData();
  const type = options?.type ?? 'audio/webm';
  const blob = new Blob([clipBytes(options?.size ?? 2_048)], { type });
  form.append('audio', blob, 'from-the-browser.webm');
  form.append('locale', options?.locale ?? 'en-IN');
  return form;
}

/** A hand-rolled multipart body, so the transport headers can be controlled. */
function rawMultipart(bytes: Uint8Array, type: string): Uint8Array {
  const head = encoder.encode(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="locale"\r\n\r\nen-IN\r\n` +
      `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="audio"; filename="clip.webm"\r\n` +
      `Content-Type: ${type}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${BOUNDARY}--\r\n`);
  const out = new Uint8Array(head.length + bytes.length + tail.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  out.set(tail, head.length + bytes.length);
  return out;
}

/**
 * Send a body as a stream, which is how a real upload arrives and the only way
 * to control whether `Content-Length` is present or truthful.
 */
function streamRequest(body: Uint8Array, headers: Record<string, string>): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
  return new Request('https://gateway.test/listen', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, ...headers },
    body: stream,
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The slice of `fetch` init the assertions care about. Spelled out rather than
 * borrowed from `RequestInit` so the test file needs no DOM lib.
 */
interface CapturedInit {
  readonly body?: unknown;
  readonly signal?: AbortSignal | null;
}

interface FetchCall {
  readonly url: string;
  readonly init: CapturedInit;
}

/** Stub the provider and record what was sent to it. */
function stubProvider(handler: (call: FetchCall) => Promise<Response> | Response): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', (input: string | Request, init?: CapturedInit): Promise<Response> => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(handler(call));
  });
  return calls;
}

function bodyForm(call: FetchCall): FormData {
  const body = call.init.body;
  if (!(body instanceof FormData)) throw new Error('provider was not sent a FormData body');
  return body;
}

beforeEach(() => {
  sessionCounter += 1;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('POST /listen — the happy path', () => {
  it('returns the transcript for an ordinary clip', async () => {
    stubProvider(() => jsonResponse({ text: '  a table for four at seven  ' }));

    const response = await handleListen(formRequest(audioForm()), env, claimsWith());

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ text: 'a table for four at seven' });
  });

  it('sends the configured model and the validated filename to the provider', async () => {
    const calls = stubProvider(() => jsonResponse({ text: 'hello' }));

    await handleListen(formRequest(audioForm({ type: 'audio/ogg' })), env, claimsWith());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    const sent = bodyForm(calls[0] as FetchCall);
    expect(sent.get('model')).toBe(env.STT_MODEL);
    const file: unknown = sent.get('file');
    // The client's own filename is not forwarded; the extension is derived from
    // the content type we validated.
    expect(file instanceof File ? file.name : file).toBe('clip.ogg');
  });
});

describe('POST /listen — size caps', () => {
  it('rejects an oversized Content-Length without reading the body', async () => {
    const calls = stubProvider(() => jsonResponse({ text: 'never reached' }));
    const request = streamRequest(rawMultipart(clipBytes(64), 'audio/webm'), {
      'Content-Length': String(LIMITS.maxListenBytes + 1),
    });

    const response = await handleListen(request, env, claimsWith());

    expect(response.status).toBe(413);
    expect(await response.json()).toStrictEqual({
      error: expect.any(String) as unknown as string,
      code: 'audio_too_large',
      retryable: false,
    });
    // The whole point of checking the header: the body is still untouched, so
    // the refusal cost a header parse rather than 400KB of upload.
    expect(request.bodyUsed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('does consume the body when the declared length is within the cap', async () => {
    // The control for the assertion above: `bodyUsed` genuinely distinguishes
    // the two paths rather than being false for every request.
    stubProvider(() => jsonResponse({ text: 'ok' }));
    const request = streamRequest(rawMultipart(clipBytes(64), 'audio/webm'), {});

    const response = await handleListen(request, env, claimsWith());

    expect(response.status).toBe(200);
    expect(request.bodyUsed).toBe(true);
  });

  it('rejects an oversized body when no Content-Length was declared', async () => {
    const calls = stubProvider(() => jsonResponse({ text: 'never reached' }));
    const oversized = rawMultipart(clipBytes(LIMITS.maxListenBytes + 1_024), 'audio/webm');

    const response = await handleListen(streamRequest(oversized, {}), env, claimsWith());

    expect(response.status).toBe(413);
    expect((await response.json<{ code: string }>()).code).toBe('audio_too_large');
    expect(calls).toHaveLength(0);
  });
});

describe('POST /listen — malformed input', () => {
  it('rejects a body that is not multipart', async () => {
    const calls = stubProvider(() => jsonResponse({ text: 'never reached' }));
    const request = new Request('https://gateway.test/listen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: 'not really' }),
    });

    const response = await handleListen(request, env, claimsWith());

    expect(response.status).toBe(400);
    expect((await response.json<{ code: string }>()).code).toBe('bad_request');
    expect(calls).toHaveLength(0);
  });

  it('rejects a form with no audio part', async () => {
    stubProvider(() => jsonResponse({ text: 'never reached' }));
    const form = new FormData();
    form.append('locale', 'en-IN');

    const response = await handleListen(formRequest(form), env, claimsWith());

    expect(response.status).toBe(400);
    expect((await response.json<{ code: string }>()).code).toBe('bad_request');
  });

  it('rejects audio sent as a plain field rather than a file', async () => {
    stubProvider(() => jsonResponse({ text: 'never reached' }));
    const form = new FormData();
    form.append('audio', 'a table for four');
    form.append('locale', 'en-IN');

    const response = await handleListen(formRequest(form), env, claimsWith());

    expect(response.status).toBe(400);
    expect((await response.json<{ code: string }>()).code).toBe('bad_request');
  });

  it('rejects a content type outside the allowlist', async () => {
    const calls = stubProvider(() => jsonResponse({ text: 'never reached' }));

    const response = await handleListen(
      formRequest(audioForm({ type: 'audio/aiff' })),
      env,
      claimsWith(),
    );

    expect(response.status).toBe(415);
    expect((await response.json<{ code: string }>()).code).toBe('unsupported_media');
    expect(calls).toHaveLength(0);
  });

  it('accepts the parameterised type MediaRecorder actually produces', async () => {
    stubProvider(() => jsonResponse({ text: 'seven o clock' }));

    const response = await handleListen(
      formRequest(audioForm({ type: 'audio/webm;codecs=opus' })),
      env,
      claimsWith(),
    );

    expect(response.status).toBe(200);
  });
});

describe('POST /listen — locale handling', () => {
  it('does not forward an unknown locale, falling back to the default language', async () => {
    const calls = stubProvider(() => jsonResponse({ text: 'ok' }));

    await handleListen(
      formRequest(audioForm({ locale: 'fr-FR; drop table' })),
      env,
      claimsWith(),
    );

    const sent = bodyForm(calls[0] as FetchCall);
    expect(sent.get('language')).toBe('en');
    for (const [, value] of sent.entries()) {
      if (typeof value === 'string') expect(value).not.toContain('fr-FR');
    }
  });

  it('maps a known locale to its language code', async () => {
    const calls = stubProvider(() => jsonResponse({ text: 'ok' }));

    await handleListen(formRequest(audioForm({ locale: 'en-US' })), env, claimsWith());

    expect(bodyForm(calls[0] as FetchCall).get('language')).toBe('en');
  });
});

describe('POST /listen — quota', () => {
  it('refuses once the session has spent its clips', async () => {
    const calls = stubProvider(() => jsonResponse({ text: 'never reached' }));

    const response = await handleListen(
      formRequest(audioForm()),
      env,
      claimsWith({ turns: 12, ttsSeconds: 90, clips: 0 }),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toStrictEqual({
      error: expect.any(String) as unknown as string,
      code: 'session_clips_exhausted',
      // The fallback is typed mode, which is complete. Nothing to retry.
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('charges exactly one clip per accepted request', async () => {
    stubProvider(() => jsonResponse({ text: 'ok' }));
    const claims = claimsWith({ turns: 12, ttsSeconds: 90, clips: 1 });

    const first = await handleListen(formRequest(audioForm()), env, claims);
    const second = await handleListen(formRequest(audioForm()), env, claims);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect((await second.json<{ code: string }>()).code).toBe('session_clips_exhausted');
  });
});

describe('POST /listen — provider failures map to §7.5 rows', () => {
  it('turns a provider 429 into a retryable 429', async () => {
    stubProvider(() => new Response('rate limited', { status: 429 }));

    const response = await handleListen(formRequest(audioForm()), env, claimsWith());

    expect(response.status).toBe(429);
    expect(await response.json()).toStrictEqual({
      error: expect.any(String) as unknown as string,
      code: 'provider_rate_limited',
      retryable: true,
    });
  });

  it('turns a provider 500 into a retryable 503', async () => {
    stubProvider(() => new Response('boom', { status: 500 }));

    const response = await handleListen(formRequest(audioForm()), env, claimsWith());

    expect(response.status).toBe(503);
    expect(await response.json<{ code: string; retryable: boolean }>()).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
  });

  it('turns an unreachable provider into a retryable 503', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network failure')));

    const response = await handleListen(formRequest(audioForm()), env, claimsWith());

    expect(response.status).toBe(503);
    expect((await response.json<{ code: string }>()).code).toBe('provider_unavailable');
  });

  it('turns a provider 400 into a non-retryable 502', async () => {
    stubProvider(() => new Response('bad audio', { status: 400 }));

    const response = await handleListen(formRequest(audioForm()), env, claimsWith());

    expect(response.status).toBe(502);
    expect(await response.json()).toStrictEqual({
      error: expect.any(String) as unknown as string,
      code: 'provider_rejected',
      retryable: false,
    });
  });

  it('turns an unreadable success payload into a 502', async () => {
    stubProvider(() => new Response('not json at all', { status: 200 }));

    const response = await handleListen(formRequest(audioForm()), env, claimsWith());

    expect(response.status).toBe(502);
    expect((await response.json<{ code: string }>()).code).toBe('provider_rejected');
  });

  it('gives up on a provider that never answers, as a 504', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      (_input: string | Request, init?: CapturedInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );

    const pending = handleListen(formRequest(audioForm()), env, claimsWith());
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await pending;

    expect(response.status).toBe(504);
    expect(await response.json()).toStrictEqual({
      error: expect.any(String) as unknown as string,
      code: 'provider_timeout',
      retryable: true,
    });
  });
});

describe('POST /listen — what must not leave the gateway', () => {
  it('drops the provider segments, timings and logprobs', async () => {
    stubProvider(() =>
      jsonResponse({
        text: 'a table for four',
        task: 'transcribe',
        language: 'english',
        duration: 3.42,
        x_groq: { id: 'req_internal_identifier' },
        segments: [
          { id: 0, start: 0, end: 3.42, text: 'a table for four', avg_logprob: -0.21, tokens: [1, 2, 3] },
        ],
      }),
    );

    const response = await handleListen(formRequest(audioForm()), env, claimsWith());
    const body = await response.text();

    expect(JSON.parse(body)).toStrictEqual({ text: 'a table for four' });
    expect(body).not.toContain('segments');
    expect(body).not.toContain('avg_logprob');
    expect(body).not.toContain('req_internal_identifier');
  });

  it('passes a numeric confidence through when a provider reports one', async () => {
    stubProvider(() => jsonResponse({ text: 'seven', confidence: 0.91, segments: [] }));

    const response = await handleListen(formRequest(audioForm()), env, claimsWith());

    expect(await response.json()).toStrictEqual({ text: 'seven', confidence: 0.91 });
  });

  it('never puts the STT key in a response, even when the provider echoes it', async () => {
    const key = env.STT_API_KEY;
    stubProvider(
      () =>
        new Response(JSON.stringify({ error: { message: `invalid api key: ${key}` } }), {
          status: 401,
          headers: { 'X-Upstream-Auth': `Bearer ${key}` },
        }),
    );

    const response = await handleListen(formRequest(audioForm()), env, claimsWith());
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).not.toContain(key);
    for (const [, value] of response.headers.entries()) expect(value).not.toContain(key);
  });
});

describe('POST /listen — cancellation', () => {
  it('propagates an aborted request to the provider fetch', async () => {
    let upstreamSignal: AbortSignal | undefined;
    let upstreamAborted = false;
    vi.stubGlobal(
      'fetch',
      (_input: string | Request, init?: CapturedInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          upstreamSignal = init?.signal ?? undefined;
          upstreamSignal?.addEventListener('abort', () => {
            upstreamAborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );

    const controller = new AbortController();
    const pending = handleListen(formRequest(audioForm(), controller.signal), env, claimsWith());

    // Wait for the handler to actually reach the provider before cancelling.
    while (upstreamSignal === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    controller.abort();
    const response = await pending;

    expect(upstreamAborted).toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);
    // The visitor is gone; nothing reads this, but it is still a defined code.
    expect(response.status).toBe(503);
  });
});
