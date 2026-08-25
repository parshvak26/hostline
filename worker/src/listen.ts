/**
 * `POST /listen` — hosted speech recognition (T-065).
 *
 * ## Why this endpoint exists at all
 *
 * Chrome and Edge recognise speech in the browser for free, and where they do,
 * this endpoint is never called. Firefox has no Web Speech recognition, and iOS
 * Safari's is unreliable enough that §4.7 routes it here by default. Without
 * this route those visitors do not get a degraded spoken experience — they get
 * no spoken experience, and fall back to typing (§7.5, F7).
 *
 * ## Why it is the strictest handler in the worker
 *
 * It is the only one that accepts a binary upload from an untrusted client, so
 * it is the only one where a single request can be expensive before anything
 * has been validated. The order below is deliberate: refuse on the declared
 * length before the body is read, then on the measured length, then on the
 * declared type, then charge the session, and only then spend a provider call.
 *
 * Nothing here is fatal. Every failure maps to §7.5 F8 — the client offers
 * typed mode, which is a complete way to finish a booking — which is why none
 * of these errors carries an apology and why the retryable flags mean what they
 * say rather than being set defensively.
 *
 * **No audio, no transcript, and no part of either is ever logged.** The README
 * claims this gateway forwards conversation content and retains none of it; the
 * visitor's recorded voice is the sharpest case of that claim (§12.8, §13).
 */

import type { Env, SessionClaims } from './types.js';
import { LIMITS } from './types.js';
import { jsonError } from './session.js';
import { spend } from './quota.js';
import { sttAdapter } from './providers/stt.js';

/**
 * Accepted container types, mapped to the extension the clip is uploaded under.
 *
 * **This validates the content type the client declared, not the bytes it
 * sent.** A client can label an arbitrary blob `audio/webm` and it will be
 * forwarded. That is tolerable here and nowhere else: the blob is capped at
 * 400KB, it is charged against a 25-clip session quota, and the only thing
 * downstream of it is a transcription API that will reject what it cannot
 * decode. Sniffing the container would be a magic-byte check per format for no
 * change in what an attacker can actually achieve.
 */
const AUDIO_TYPES: ReadonlyMap<string, string> = new Map([
  ['audio/webm', 'clip.webm'],
  ['audio/ogg', 'clip.ogg'],
  ['audio/mp4', 'clip.m4a'],
  ['audio/mpeg', 'clip.mp3'],
  ['audio/wav', 'clip.wav'],
]);

/**
 * The project has two locales (§0) and both are English, so this collapses to
 * one language code today. It stays a lookup because the point is that the
 * client's string is *matched* against a known set rather than forwarded: an
 * arbitrary field from an untrusted body has no business reaching a provider.
 */
const LOCALE_LANGUAGES: ReadonlyMap<string, string> = new Map([
  ['en-IN', 'en'],
  ['en-US', 'en'],
]);

const DEFAULT_LOCALE = 'en-IN';

/**
 * A visitor who has stopped speaking is watching a listening indicator. Past
 * this point typed mode is simply the faster answer, so waiting longer buys
 * nothing (§12.5).
 */
const PROVIDER_TIMEOUT_MS = 8_000;

function tooLarge(): Response {
  return jsonError(413, 'That clip is too long.', 'audio_too_large', false);
}

export async function handleListen(request: Request, env: Env, claims: SessionClaims): Promise<Response> {
  // The declared length is only a claim, but it is a claim that arrives before
  // the body does. Refusing on it means an oversized upload costs one header
  // parse instead of 400KB-plus of streamed body.
  const declaredLength = request.headers.get('Content-Length');
  if (declaredLength !== null) {
    const bytes = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(bytes) && bytes > LIMITS.maxListenBytes) return tooLarge();
  }

  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return jsonError(400, 'Expected a multipart/form-data body.', 'bad_request', false);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, 'Could not read the uploaded clip.', 'bad_request', false);
  }

  // Typed as `unknown` because the runtime hands back a `File` for a file part
  // and a `string` for a plain field, while the non-experimental
  // `@cloudflare/workers-types` still declares only `string | null`. The
  // `instanceof` below is the narrowing that actually holds.
  const audio: unknown = form.get('audio');
  // Anything that is not a blob — a missing part, or `audio` sent as a plain
  // text field — gets the same answer, because in each case there is no clip.
  if (!(audio instanceof Blob)) {
    return jsonError(400, 'A file part named "audio" is required.', 'bad_request', false);
  }

  // And now the measurement, because the header was a claim. A client that
  // omits `Content-Length` or lies in it reaches exactly this line.
  if (audio.size > LIMITS.maxListenBytes) return tooLarge();
  if (audio.size === 0) return jsonError(400, 'The clip is empty.', 'bad_request', false);

  // `audio/webm;codecs=opus` is what MediaRecorder actually produces.
  const declaredType = (audio.type.split(';')[0] ?? '').trim().toLowerCase();
  const filename = AUDIO_TYPES.get(declaredType);
  if (filename === undefined) {
    return jsonError(415, 'That audio format is not supported.', 'unsupported_media', false);
  }

  const requestedLocale = form.get('locale');
  const locale =
    typeof requestedLocale === 'string' && LOCALE_LANGUAGES.has(requestedLocale)
      ? requestedLocale
      : DEFAULT_LOCALE;
  const language = LOCALE_LANGUAGES.get(locale) ?? 'en';

  // Charged before the provider call, not after it. A refund would be a second
  // KV write, and writes are the scarce resource this whole design is built
  // around (see quota.ts); a clip lost to a provider outage costs the visitor
  // nothing, because a provider outage puts them in typed mode anyway.
  const charged = await spend(env, claims.sid, claims.quota, 'clips');
  if (!charged.allowed) {
    // Not retryable: the fallback is typed mode, which is complete. There is
    // nothing for the client to come back for.
    return jsonError(429, 'No recognition clips left in this session.', 'session_clips_exhausted', false);
  }

  // One controller for two abort sources: the visitor navigating away or
  // cancelling the recording, and our own deadline. The provider fetch sees
  // either as the same signal, which is the point of combining them.
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PROVIDER_TIMEOUT_MS);
  const relayAbort = (): void => {
    controller.abort();
  };
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener('abort', relayAbort, { once: true });

  try {
    let upstream: Response;
    try {
      upstream = await sttAdapter.transcribe({ audio, filename, language }, env, controller.signal);
    } catch {
      // Either our deadline fired or the provider was unreachable. The thrown
      // error is not inspected beyond that and never reaches the client: an
      // upstream message can carry request detail, and no client behaviour
      // depends on which flavour of unreachable it was.
      return timedOut
        ? jsonError(504, 'Recognition took too long.', 'provider_timeout', true)
        : jsonError(503, 'Recognition is unavailable.', 'provider_unavailable', true);
    }

    // Each of these is a row in §7.5. `retryable` tracks whether coming back
    // could plausibly work: a rate limit clears, a bad request does not.
    if (upstream.status === 429) {
      return jsonError(429, 'Recognition is busy.', 'provider_rate_limited', true);
    }
    if (upstream.status >= 500) {
      return jsonError(503, 'Recognition is unavailable.', 'provider_unavailable', true);
    }
    if (!upstream.ok) {
      return jsonError(502, 'Recognition rejected the clip.', 'provider_rejected', false);
    }

    let payload: unknown;
    try {
      payload = await upstream.json();
    } catch {
      return jsonError(502, 'Recognition returned an unreadable reply.', 'provider_rejected', false);
    }

    // Re-serialised from the two fields in the §11 contract rather than
    // forwarded. The provider's payload can carry segment timings, token
    // logprobs and a duration; the client uses none of them, and passing them
    // through would widen what leaves the device for no benefit.
    const transcript = sttAdapter.parseTranscript(payload);
    if (transcript === null) {
      return jsonError(502, 'Recognition returned nothing usable.', 'provider_rejected', false);
    }

    return new Response(JSON.stringify(transcript), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    clearTimeout(deadline);
    request.signal.removeEventListener('abort', relayAbort);
  }
}
