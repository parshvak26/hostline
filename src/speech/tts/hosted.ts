/**
 * Hosted neural speech, through the gateway (T-064 client side).
 *
 * The middle rung of the cascade: better than the browser's own voice, worse
 * than a cache hit, and the only one that can cost anything — which is why it
 * is the only one behind a quota.
 *
 * Voice quality is the single biggest driver of whether this feels like a
 * product or a demo (plan §8), so it is worth a network round trip. It is not
 * worth a stall: every failure here falls through to `speechSynthesis` and the
 * visitor hears the same words in a plainer voice (plan §7.5 F5).
 */

import type { SpeechClip, SpeechOutput, SpeechRequest } from '../../agent/ports.js';
import type { GatewayClient } from '../../gateway/client.js';

export interface HostedSpeechOptions {
  readonly client: GatewayClient;
  readonly voice?: string;
}

export class HostedSpeech implements SpeechOutput {
  readonly kind = 'hosted' as const;

  private controller: AbortController | null = null;

  constructor(private readonly options: HostedSpeechOptions) {}

  async resolve(request: SpeechRequest, signal?: AbortSignal): Promise<SpeechClip> {
    const started = performance.now();

    // A local controller, chained to the caller's signal, so `cancel()` works
    // whether or not the caller passed one. Barge-in has to abort the upstream
    // request and not merely stop the audio, or the agent finishes composing a
    // sentence nobody is listening to (T-085).
    const controller = new AbortController();
    this.controller = controller;
    const forward = (): void => controller.abort();
    signal?.addEventListener('abort', forward, { once: true });

    try {
      const audio = await this.options.client.speak(
        request.text,
        this.options.voice ?? 'default',
        controller.signal,
      );
      return { source: 'hosted', audio, resolvedInMs: performance.now() - started };
    } finally {
      signal?.removeEventListener('abort', forward);
      if (this.controller === controller) this.controller = null;
    }
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }
}
