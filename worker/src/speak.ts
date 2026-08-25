/**
 * `POST /speak` — hosted synthesis (T-064).
 *
 * ## Why this endpoint exists at all
 *
 * The client checks its prebaked cache first and only lands here on a miss —
 * which in practice means one line: the read-back that contains the visitor's
 * own name, and which therefore cannot be baked (`scripts/bake-audio.ts`).
 * Everything else the agent says is served from `public/audio/` at 0ms.
 *
 * ## Why it streams instead of buffering
 *
 * Plan §12.5 allows 200–400ms for synthesis on a miss, inside a p50 budget of
 * one second. Buffering the clip would add the *entire* synthesis time to that
 * line rather than the time-to-first-chunk, so the provider's body is handed
 * back untouched and the browser starts playing while the tail is still being
 * generated. It also means this worker never holds a complete recording of
 * anything a visitor was told, which is the storage posture in plan §12.8.
 *
 * ## Why none of the failures below are fatal
 *
 * Every one maps to §7.5 **F5**, whose defined response is a single line:
 * *browser voice*. `speechSynthesis` says the same words with the same text, so
 * a visitor cannot tell a failure here from a success. That is the reason
 * `session_tts_exhausted` is marked `retryable: false` — there is nothing to
 * retry towards, the fallback is already the complete experience.
 */

import type { Env, SessionClaims } from './types.js';
import { LIMITS } from './types.js';
import { jsonError } from './session.js';
import { spend } from './quota.js';
import type { SpeechRequest } from './providers/tts.js';
import { ttsAdapter } from './providers/tts.js';

/**
 * How long to wait for the provider's *first bytes*.
 *
 * The timer is cleared as soon as the response headers arrive, so this bounds
 * time-to-first-chunk rather than the length of the clip. Eight seconds is long
 * past the point where the client gave up and spoke the line itself; the only
 * thing left to win by then is releasing the upstream connection.
 */
const TTS_TIMEOUT_MS = 8_000;

/**
 * Characters of written text per second of speech.
 *
 * English synthesis at a natural pace runs somewhere between 14 and 16
 * characters a second. The low end is chosen deliberately: dividing by 14
 * charges *more* seconds than dividing by 16, and the direction to be wrong in
 * is "charged too much" — over-charging costs one visitor a line of hosted
 * audio they will hear in the browser's voice instead, while under-charging
 * spends a shared free tier that everyone else is queueing for.
 *
 * **This is an estimate and it is never reconciled.** The real duration is not
 * knowable before synthesis, and it is not knowable afterwards either, because
 * measuring it would mean buffering the clip — the one thing §12.5 rules out.
 * So `ttsSeconds` is a rough governor on how much one session may ask for, not
 * an accounting record. The actual backstop on spend is the same one as
 * everywhere else in this worker: the provider's own free-tier limit, which
 * returns 429 and drops the visitor to browser speech (plan §11).
 */
const CHARS_PER_SECOND = 14;

/** Conservative seconds-of-speech estimate for a line. Always at least one. */
export function estimateSeconds(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_SECOND));
}

/** True for the `TimeoutError` our own timer raises, without assuming DOMException. */
function isTimeoutError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError';
}

interface SpeakBody {
  readonly text?: unknown;
  readonly voice?: unknown;
  readonly format?: unknown;
}

export async function handleSpeak(request: Request, env: Env, claims: SessionClaims): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return jsonError(400, 'Missing or unreadable request body.', 'bad_request', false);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return jsonError(400, 'Missing or unreadable request body.', 'bad_request', false);
  }

  const body = parsed as SpeakBody;
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    return jsonError(400, 'A line of text is required.', 'bad_request', false);
  }

  // The client applies the same 240-character cap before it calls. It is
  // repeated here because the client is untrusted code running on someone
  // else's machine, and this is the copy that is actually enforced (plan §7.4).
  if (body.text.length > LIMITS.maxSpeakChars) {
    return jsonError(413, 'That line is too long to speak.', 'text_too_long', false);
  }

  // One format exists, so an unexpected value is a client bug rather than a
  // negotiation. Rejecting it is cheaper than synthesising something unplayable.
  if (body.format !== undefined && body.format !== 'opus') {
    return jsonError(400, 'Only opus audio is supported.', 'bad_request', false);
  }

  const text = body.text.trim();
  const estimate = estimateSeconds(text);

  // Charged before synthesis, and not refunded if synthesis then fails. A
  // refund would be a second KV write per failure, and writes are the scarce
  // resource this whole design is bent around (see quota.ts). The cost of the
  // simpler rule is that a session losing a provider call loses a few seconds
  // of a ninety-second budget.
  const charged = await spend(env, claims.sid, claims.quota, 'ttsSeconds', estimate);
  if (!charged.allowed) {
    return jsonError(429, 'This session has used its hosted speech.', 'session_tts_exhausted', false);
  }

  const speech: SpeechRequest = {
    text,
    // `voice` is part of the §11 request shape and is accepted, but the value
    // the provider sees always comes from the binding. A voice name is a
    // provider-side identifier tied to a model, and the product offers no
    // per-visitor voice choice — forwarding an arbitrary string would give an
    // untrusted caller a field on a request signed with our key, for no feature.
    voice: env.TTS_VOICE,
    format: 'opus',
  };

  const controller = new AbortController();
  // The incoming request's signal fires when the visitor talks over the agent
  // and the client aborts; forwarding it is what makes barge-in cancel the
  // upstream synthesis rather than just discarding its output (T-085).
  const clientSignal = request.signal;
  const forwardAbort = (): void => {
    controller.abort();
  };
  clientSignal.addEventListener('abort', forwardAbort);
  if (clientSignal.aborted) controller.abort();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Speech provider timed out.', 'TimeoutError'));
  }, TTS_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await ttsAdapter.synthesise(speech, env, controller.signal);
  } catch (error) {
    if (timedOut || isTimeoutError(error)) {
      return jsonError(504, 'The speech provider did not answer in time.', 'provider_timeout', true);
    }
    if (clientSignal.aborted) {
      // The visitor interrupted. Nobody is waiting for this body; the status is
      // for the log, not for a client that has already moved on.
      return new Response(null, { status: 499 });
    }
    return jsonError(503, 'The speech provider is unavailable.', 'provider_unavailable', true);
  } finally {
    // Headers have arrived (or the attempt is over), so the deadline no longer
    // applies. The abort listener stays attached: it is what a mid-clip barge-in
    // uses to cancel the rest of the stream.
    clearTimeout(timer);
  }

  if (upstream.ok && upstream.body !== null) {
    return new Response(upstream.body, {
      status: 200,
      // Built fresh rather than copied. Nothing the provider chose to put on
      // its response — request echoes, account identifiers, rate-limit detail —
      // has any business reaching the browser.
      headers: {
        'Content-Type': 'audio/ogg',
        // This clip is the read-back, so it contains the visitor's own name.
        // It must not sit in any cache between here and the browser (§12.8).
        'Cache-Control': 'no-store',
      },
    });
  }

  // The provider's error body is dropped unread: it can echo the request back,
  // and a body from a call made with our key is not something to forward.
  void upstream.body?.cancel().catch(() => undefined);

  if (upstream.status === 429) {
    // The free tier for the day is spent. §7.5 F5: browser voice, and the next
    // session may well succeed, so this one is worth retrying.
    return jsonError(429, 'The speech provider is busy.', 'provider_rate_limited', true);
  }
  if (upstream.status === 408 || upstream.status === 504) {
    return jsonError(504, 'The speech provider did not answer in time.', 'provider_timeout', true);
  }
  if (upstream.status >= 500) {
    return jsonError(503, 'The speech provider is unavailable.', 'provider_unavailable', true);
  }
  // A 4xx that is not a rate limit means the request itself was wrong — a
  // rejected key, a retired model name. Retrying reproduces it exactly, so the
  // client should not; it needs the operator, and the visitor needs the
  // browser's voice in the meantime.
  return jsonError(502, 'The speech provider rejected the request.', 'provider_rejected', false);
}
