/**
 * Hosted speech recognition, through the gateway (T-071).
 *
 * ## Why this exists
 *
 * Chrome and Edge recognise speech in the browser, for free, with interim
 * results. **Firefox cannot, and iOS Safari's implementation is unreliable
 * enough that plan §4.7 routes iOS here by default.** Without this adapter those
 * visitors lose the spoken experience entirely and fall back to typing — which
 * works, but is not what they came to try.
 *
 * ## What it costs
 *
 * Honesty first, because this is the rung with the real trade-off:
 *
 *   - **No interim results.** A clip is recorded, uploaded and transcribed, so
 *     the words appear all at once rather than building live. The UI shows a
 *     quiet "…" instead of a growing sentence (plan §4.5).
 *   - **Latency.** Upload plus transcription lands well above the Web Speech
 *     path. It is measured and published rather than hidden.
 *   - **The audio leaves the device.** In Chrome the browser already sends it to
 *     Google; here it goes to the gateway and on to the recognition provider.
 *     The page says so before the microphone is first used.
 *
 * Endpointing is done locally by the shared endpointer in `./index.ts`, driven
 * by microphone energy rather than by transcript activity, because there are no
 * interim transcripts here to drive it.
 */

import type { SpeechInput, SpeechInputHandlers } from '../../agent/ports.js';
import type { GatewayClient } from '../../gateway/client.js';
import { GATEWAY, LISTENING } from '../../config/settings.js';
import { rms } from '../vad.js';

/** MediaRecorder is not in every lib target; declare only what is used. */
interface RecorderLike {
  start(timesliceMs?: number): void;
  stop(): void;
  state: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
}

interface RecorderConstructor {
  new (stream: MediaStream, options?: { mimeType?: string; audioBitsPerSecond?: number }): RecorderLike;
  isTypeSupported?(type: string): boolean;
}

/** Ordered by how well the recognition providers handle them. */
const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

function recorderConstructor(): RecorderConstructor | null {
  const candidate = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  return typeof candidate === 'function' ? (candidate as unknown as RecorderConstructor) : null;
}

function bestMimeType(ctor: RecorderConstructor): string | undefined {
  if (typeof ctor.isTypeSupported !== 'function') return undefined;
  return PREFERRED_TYPES.find((type) => ctor.isTypeSupported?.(type) === true);
}

export interface HostedSpeechInputOptions {
  readonly client: GatewayClient;
  readonly locale: string;
  /** Injected in tests. Defaults to the real microphone. */
  readonly getStream?: () => Promise<MediaStream>;
}

/**
 * Factory matching the contract `./index.ts` expects, so the selector can pick
 * this up without either file importing the other eagerly.
 */
export function createHostedSpeechInput(options: HostedSpeechInputOptions): SpeechInput {
  return new HostedSpeechInput(options);
}

class HostedSpeechInput implements SpeechInput {
  readonly kind = 'hosted' as const;

  private handlers: SpeechInputHandlers | null = null;
  private recorder: RecorderLike | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private context: AudioContext | null = null;
  private samples: Float32Array | null = null;
  private chunks: Blob[] = [];
  private muted = false;
  private stopping = false;
  private controller: AbortController | null = null;
  private currentLevel = 0;
  private levelTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: HostedSpeechInputOptions) {}

  async isAvailable(): Promise<boolean> {
    // Deliberately does not touch getUserMedia — checking availability must
    // never trigger a permission prompt (plan §13).
    return recorderConstructor() !== null && this.options.client.configured;
  }

  async start(handlers: SpeechInputHandlers): Promise<void> {
    this.handlers = handlers;

    const ctor = recorderConstructor();
    if (ctor === null) {
      handlers.onError({ kind: 'not_supported' });
      return;
    }

    try {
      const getStream =
        this.options.getStream ??
        (() =>
          navigator.mediaDevices.getUserMedia({
            audio: {
              // The acoustic half of R-25. The other half is gating recognition
              // during playback, which the shared wrapper in ./index.ts does.
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          }));
      this.stream = await getStream();
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : '';
      handlers.onError({
        kind: name === 'NotAllowedError' ? 'permission_denied' : name === 'NotFoundError' ? 'no_microphone' : 'unknown',
        ...(name === 'NotAllowedError' || name === 'NotFoundError' ? {} : { detail: name }),
      } as Parameters<SpeechInputHandlers['onError']>[0]);
      return;
    }

    this.attachLevelMeter(this.stream);

    const mimeType = bestMimeType(ctor);
    this.recorder = new ctor(this.stream, {
      ...(mimeType === undefined ? {} : { mimeType }),
      // Roughly 24kbps mono keeps a ten-second clip inside the 400KB cap with
      // a wide margin, so an upload is never refused for size.
      audioBitsPerSecond: 24_000,
    });

    this.chunks = [];
    this.recorder.ondataavailable = (event): void => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.onstop = (): void => void this.transcribe();
    this.recorder.onerror = (): void => handlers.onError({ kind: 'unknown', detail: 'recorder_error' });
    this.recorder.start();
  }

  /**
   * End the current utterance and send it.
   *
   * Called by the endpointer, which is watching microphone energy — there are
   * no interim transcripts here to time silence against.
   */
  endTurn(): void {
    if (this.recorder === null || this.recorder.state !== 'recording') return;
    this.stopping = true;
    this.recorder.stop();
  }

  private async transcribe(): Promise<void> {
    const handlers = this.handlers;
    const chunks = this.chunks;
    this.chunks = [];
    this.stopping = false;

    // Restart immediately so the next utterance is already being captured while
    // this one is in flight. Dropping audio during the upload would clip the
    // start of whatever the visitor says next.
    if (this.recorder !== null && this.recorder.state === 'inactive' && !this.muted) {
      try {
        this.recorder.start();
      } catch {
        // A recorder that will not restart is a dead path; the next endTurn
        // simply does nothing and the visitor is offered typing.
      }
    }

    if (handlers === null || chunks.length === 0) return;

    const blob = new Blob(chunks, { type: chunks[0]?.type ?? 'audio/webm' });
    if (blob.size > GATEWAY.maxListenBytes) {
      handlers.onError({ kind: 'unknown', detail: 'clip_too_large' });
      return;
    }

    const controller = new AbortController();
    this.controller = controller;

    try {
      const result = await this.options.client.listen(blob, this.options.locale, controller.signal);
      if (result.text.trim() === '') return;
      handlers.onTranscript({
        text: result.text,
        isFinal: true,
        ...(result.confidence === undefined ? {} : { confidence: result.confidence }),
      });
      handlers.onEndOfSpeech(result.text);
    } catch {
      // Every failure here means the same thing to the visitor: offer typing
      // (plan §7.5 F8). The gateway client has already mapped the status.
      handlers.onError({ kind: 'network' });
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private attachLevelMeter(stream: MediaStream): void {
    try {
      const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      if (Ctx === undefined) return;
      this.context = new Ctx();
      const source = this.context.createMediaStreamSource(stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0;
      source.connect(this.analyser);
      this.samples = new Float32Array(this.analyser.fftSize);

      this.levelTimer = setInterval(() => {
        const analyser = this.analyser;
        const samples = this.samples;
        if (analyser === null || samples === null) return;
        analyser.getFloatTimeDomainData(samples);
        this.currentLevel = this.muted ? 0 : rms(samples);
      }, 50);
    } catch {
      // No level meter means a static listening indicator. Not worth failing
      // the whole path over.
    }
  }

  stop(): void {
    if (this.levelTimer !== null) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    this.controller?.abort();
    this.controller = null;
    if (this.recorder !== null && this.recorder.state === 'recording' && !this.stopping) {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.recorder = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.analyser = null;
    this.currentLevel = 0;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    // Muting the track rather than pausing the recorder: the recorder keeps a
    // continuous timeline, and a paused one produces clips the decoder dislikes.
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    if (muted) this.currentLevel = 0;
  }

  level(): number {
    return this.currentLevel;
  }

  /** Milliseconds of silence before this adapter ends a turn. */
  static get silenceMs(): number {
    return LISTENING.endpointSilenceMs;
  }
}
