/**
 * The speech cascade (T-082): prebaked → hosted → browser.
 *
 * Three sources, tried in order, each a complete answer on its own:
 *
 *   1. **Prebaked.** A clip baked at build time. 0ms of synthesis. Covers the
 *      fixed lines, which is most of what the agent says.
 *   2. **Hosted.** A neural voice through the gateway. Costs a round trip and a
 *      slice of the free tier, and is worth both for the lines that carry the
 *      visitor's own details.
 *   3. **Browser.** `speechSynthesis`. Free, offline, always there, and plainer
 *      than the other two.
 *
 * The cascade is the degradation chain made concrete. Rung three needs no
 * network, no key and no account, so there is no combination of failures that
 * leaves the agent silent — which is what R-32 asks for and what the
 * `no-gateway` end-to-end test proves.
 *
 * One rule worth stating: a rung is skipped, never retried. A hosted request
 * that failed once in this session is unlikely to succeed on the next line, and
 * spending another two seconds finding out is exactly the dead air R-23
 * forbids.
 */

import type { SpeechClip, SpeechOutput, SpeechRequest } from '../../agent/ports.js';
import { PrebakedSpeech } from './prebaked.js';
import { HostedSpeech } from './hosted.js';
import type { BrowserSpeechOutput } from './browser.js';
import { createBrowserSpeechOutput } from './browser.js';

export { PrebakedSpeech, HostedSpeech, createBrowserSpeechOutput };
export type { BrowserSpeechOutput };

export interface CascadeOptions {
  readonly prebaked?: PrebakedSpeech;
  readonly hosted?: HostedSpeech;
  readonly browser?: BrowserSpeechOutput;
  /** Called whenever a rung is used, for the latency readout and the docs. */
  readonly onSource?: (source: SpeechClip['source'], ms: number) => void;
}

export class SpeechCascade implements SpeechOutput {
  readonly kind = 'cascade' as const;

  /** Set once a hosted request has failed; skipped for the rest of the visit. */
  private hostedOut = false;

  constructor(private readonly options: CascadeOptions) {}

  get prebaked(): PrebakedSpeech | undefined {
    return this.options.prebaked;
  }

  /** True when the hosted rung has been written off for this session. */
  get hostedAvailable(): boolean {
    return this.options.hosted !== undefined && !this.hostedOut;
  }

  async warm(): Promise<void> {
    await this.options.prebaked?.warm();
  }

  async resolve(request: SpeechRequest, signal?: AbortSignal): Promise<SpeechClip> {
    const prebaked = this.options.prebaked;
    if (prebaked !== undefined && PrebakedSpeech.idFor(request) !== null) {
      try {
        const clip = await prebaked.resolve(request, signal);
        this.options.onSource?.('prebaked', clip.resolvedInMs);
        return clip;
      } catch {
        // A miss is the normal case for anything containing a visitor's name.
      }
    }

    if (signal !== undefined && signal.aborted) throw new Error('aborted');

    const hosted = this.options.hosted;
    if (hosted !== undefined && !this.hostedOut) {
      try {
        const clip = await hosted.resolve(request, signal);
        this.options.onSource?.('hosted', clip.resolvedInMs);
        return clip;
      } catch (error: unknown) {
        // An abort is the visitor interrupting, not the provider failing. Do
        // not write the rung off for a barge-in.
        const aborted = (signal !== undefined && signal.aborted) || (error instanceof Error && error.message === 'aborted');
        if (aborted) throw error;
        this.hostedOut = true;
      }
    }

    if (signal !== undefined && signal.aborted) throw new Error('aborted');

    const browser = this.options.browser;
    if (browser === undefined) throw new Error('no speech output available');
    const clip = await browser.resolve(request, signal);
    this.options.onSource?.('browser', clip.resolvedInMs);
    return clip;
  }

  /**
   * Speak a line that `resolve` handed back with no audio.
   *
   * Only the browser rung owns its own output device; the other two return a
   * buffer for the queue. So a `null` clip means "the browser voice has this",
   * and this is how it gets told.
   *
   * **This method's absence was a real bug**, and an instructive one: the
   * orchestrator calls `speech.speak?.(…)` optionally, so a cascade without it
   * failed *silently* — the default build, with no gateway and no baked clips,
   * had no voice at all and nothing anywhere reported a problem. Optional
   * chaining onto an interface method hides exactly this. The port declares
   * `speak` as optional because the prebaked and hosted rungs genuinely do not
   * have one; the cascade, which can end on the browser, always does.
   */
  async speak(request: SpeechRequest, signal?: AbortSignal): Promise<void> {
    const browser = this.options.browser;
    if (browser?.speak === undefined) return;
    await browser.speak(request, signal);
  }

  /** Resolve and speak in one call, reporting which rung answered. */
  async speakOrResolve(request: SpeechRequest, signal?: AbortSignal): Promise<SpeechClip> {
    const clip = await this.resolve(request, signal);
    if (clip.audio === null) await this.speak(request, signal);
    return clip;
  }

  cancel(): void {
    this.options.prebaked?.cancel();
    this.options.hosted?.cancel();
    this.options.browser?.cancel();
  }
}
