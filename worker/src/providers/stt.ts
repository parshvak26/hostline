/**
 * Hosted speech recognition, behind one swappable seam (T-065).
 *
 * Plan §0 picks Groq's Whisper large-v3-turbo, but records that free tiers move
 * and that the adapter layer exists so a change of provider is a change to one
 * file. Nothing outside this module knows the endpoint, the wire format, or the
 * shape of what comes back — `listen.ts` only knows that it gets a `Response`
 * and can ask for the transcript out of the parsed payload.
 *
 * The endpoint is OpenAI-compatible, which is most of why it was chosen: the
 * two fallback providers in §0 speak the same multipart dialect, so swapping
 * one in is a URL and a key rather than a rewrite.
 */

import type { Env } from '../types.js';

const TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

export interface TranscribeRequest {
  readonly audio: Blob;
  /**
   * The name the clip is uploaded under. Whisper servers key their container
   * sniffing off the extension, so this is functional rather than cosmetic —
   * and it is derived from the validated content type, never taken from the
   * client's own filename.
   */
  readonly filename: string;
  /** ISO-639-1, not a BCP-47 tag. Omitted to let the provider auto-detect. */
  readonly language?: string;
}

/** The only two fields that leave the gateway. See {@link parseTranscript}. */
export interface Transcript {
  readonly text: string;
  readonly confidence?: number;
}

export interface SttAdapter {
  readonly name: string;
  transcribe(req: TranscribeRequest, env: Env, signal: AbortSignal): Promise<Response>;
  /**
   * Narrow a provider payload to {@link Transcript}, or `null` if it does not
   * contain a transcript at all. Lives with the adapter because the payload
   * shape is provider knowledge.
   */
  parseTranscript(payload: unknown): Transcript | null;
}

export const sttAdapter: SttAdapter = {
  name: 'groq-whisper',

  transcribe(req: TranscribeRequest, env: Env, signal: AbortSignal): Promise<Response> {
    const form = new FormData();
    form.append('file', req.audio, req.filename);
    // The model is configuration, not code: §0 says to record what was actually
    // verified at build time, and that record is `wrangler.toml`.
    form.append('model', env.STT_MODEL);
    if (req.language !== undefined) form.append('language', req.language);
    // `verbose_json` would return per-segment timings that get discarded two
    // lines later. Asking for less means the provider generates less about the
    // visitor's voice, which is the same reason the gateway stores none of it.
    form.append('response_format', 'json');

    return fetch(TRANSCRIPTIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.STT_API_KEY}` },
      body: form,
      signal,
    });
  },

  parseTranscript(payload: unknown): Transcript | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const record = payload as { text?: unknown; confidence?: unknown };
    if (typeof record.text !== 'string') return null;

    const text = record.text.trim();
    // Whisper reports no calibrated confidence, so in practice this is absent
    // and the client treats every hosted transcript the same way. The field is
    // in the contract (§11) for a provider that does report one.
    if (typeof record.confidence === 'number' && Number.isFinite(record.confidence)) {
      return { text, confidence: record.confidence };
    }
    return { text };
  },
};
