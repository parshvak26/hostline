/**
 * The speech provider, behind one seam (T-064).
 *
 * Plan §0 picks **Groq's PlayAI TTS** because it is the fastest free-tier
 * synthesis we found and because `/chat` already holds a Groq key, so the demo
 * needs one account rather than three. If that free tier moves, §0's fallback
 * order is Cloudflare Workers AI, then Gemini TTS — and the point of this file
 * is that swapping to either is a change to {@link ttsAdapter} and nothing else.
 * `scripts/bake-audio.ts` speaks to the same endpoint with the same body; the
 * two are deliberately kept in step so a baked clip and a live clip sound alike.
 *
 * The adapter returns the provider's **raw streaming `Response`**. It does not
 * inspect the status, does not read the body, and does not map errors — those
 * are `speak.ts`'s decisions, and reading the body here would mean buffering
 * audio that plan §12.5 needs to start playing before synthesis has finished.
 *
 * Model and voice come from the environment, never from a literal here: the
 * bindings in `wrangler.toml` are the single place either is written down.
 */

import type { Env } from '../types.js';

export interface SpeechRequest {
  readonly text: string;
  readonly voice: string;
  /** Opus in an Ogg container. The only format the client plays (plan §11). */
  readonly format: 'opus';
}

export interface TtsAdapter {
  /** Identifies the provider in a comment or a bug report, not in a response. */
  readonly name: string;
  synthesise(req: SpeechRequest, env: Env, signal: AbortSignal): Promise<Response>;
}

const GROQ_SPEECH_URL = 'https://api.groq.com/openai/v1/audio/speech';

/**
 * Groq's OpenAI-compatible speech endpoint.
 *
 * `signal` is passed straight to `fetch` so that a visitor talking over the
 * agent cancels the synthesis that is still being paid for upstream (T-085),
 * rather than merely dropping the bytes at this end.
 */
export const groqPlayAiAdapter: TtsAdapter = {
  name: 'groq-playai',

  synthesise(req: SpeechRequest, env: Env, signal: AbortSignal): Promise<Response> {
    return fetch(GROQ_SPEECH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TTS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.TTS_MODEL,
        voice: req.voice,
        input: req.text,
        response_format: req.format,
      }),
      signal,
    });
  },
};

/** The adapter in use. One line to change when the free tier moves. */
export const ttsAdapter: TtsAdapter = groqPlayAiAdapter;
