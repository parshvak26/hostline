/**
 * The interfaces every adapter implements (T-040).
 *
 * This file is the reason the degradation chain in plan §7.5 is possible. Each
 * port has two or three implementations that differ only in where the work
 * happens — browser, gateway, or nowhere at all — and the orchestrator selects
 * between them without knowing the difference. Swapping a hosted neural voice
 * for `speechSynthesis` mid-conversation is a change of object, not a change of
 * code path.
 *
 * It is also what keeps the phone version in plan §28.5 a real possibility
 * rather than a line in a roadmap: the engine and these ports contain no
 * assumption that a browser exists.
 */

import type { Booking, EngineState, PhraseKey, ToolCall } from '../engine/index.js';

/* ------------------------------------------------------------- listening -- */

export interface TranscriptEvent {
  readonly text: string;
  /** Interim results render live at reduced opacity; finals settle. */
  readonly isFinal: boolean;
  /** Provider confidence where the source supplies it. */
  readonly confidence?: number;
}

export interface SpeechInputHandlers {
  onTranscript(event: TranscriptEvent): void;
  /**
   * End of speech — t0 for the latency budget.
   *
   * Fired by the endpointer on 600ms of silence, or by a final result,
   * whichever comes first. Exactly once per turn (T-042).
   */
  onEndOfSpeech(text: string): void;
  onError(error: SpeechInputError): void;
}

export type SpeechInputError =
  | { readonly kind: 'not_supported' }
  | { readonly kind: 'permission_denied' }
  | { readonly kind: 'no_microphone' }
  | { readonly kind: 'network' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'unknown'; readonly detail: string };

export interface SpeechInput {
  readonly kind: 'webspeech' | 'hosted' | 'none';
  /** Cheap enough to call on load; must not request permission. */
  isAvailable(): Promise<boolean>;
  start(handlers: SpeechInputHandlers): Promise<void>;
  stop(): void;
  /**
   * Suppress recognition while the agent is speaking, so its own voice does not
   * arrive as a visitor turn (R-25). Cheaper and more reliable than trying to
   * subtract the output signal.
   */
  setMuted(muted: boolean): void;
  /** Live microphone level, 0..1, for the listening indicator and barge-in. */
  level(): number;
}

/* -------------------------------------------------------------- speaking -- */

export interface SpeechRequest {
  readonly text: string;
  /** Present when the line came from the phrase inventory and may be prebaked. */
  readonly phraseKey?: PhraseKey;
  readonly variant?: number;
  readonly locale: string;
}

export type SpeechSource = 'prebaked' | 'hosted' | 'browser';

export interface SpeechClip {
  readonly source: SpeechSource;
  /** Resolved audio, or null when the adapter speaks by itself (browser TTS). */
  readonly audio: ArrayBuffer | null;
  /** Milliseconds from request to first playable sample. Feeds the readout. */
  readonly resolvedInMs: number;
}

export interface SpeechOutput {
  readonly kind: SpeechSource | 'cascade';
  /** Resolve text to audio. Must honour `signal` for barge-in (T-085). */
  resolve(request: SpeechRequest, signal?: AbortSignal): Promise<SpeechClip>;
  /** Speak directly, for adapters that own their own playback. */
  speak?(request: SpeechRequest, signal?: AbortSignal): Promise<void>;
  cancel(): void;
  /** Warm the path so the first real line does not pay setup cost (R-24). */
  warm?(): Promise<void>;
}

export interface AudioQueue {
  /** Unlock the audio context. Must be called from a user gesture. */
  unlock(): Promise<void>;
  /**
   * Whether audio can actually play.
   *
   * False means the context is still suspended — the browser refused the
   * gesture, or there is no Web Audio at all. Plan §7.5 F11 requires the UI to
   * offer a tap rather than silently producing no sound, and it cannot do that
   * without being told.
   */
  isUnlocked(): boolean;
  enqueue(audio: ArrayBuffer): Promise<void>;
  /** Stop everything now. Budget: under one frame (R-22). */
  flush(): void;
  isPlaying(): boolean;
  onEnded(listener: () => void): () => void;
}

/* --------------------------------------------------------------- storage -- */

export interface Transcript {
  readonly id: string;
  readonly bookingId?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly locale: string;
  readonly turns: readonly TranscriptTurn[];
  readonly outcome?: string;
  readonly latencies: readonly number[];
}

export interface TranscriptTurn {
  readonly role: 'agent' | 'visitor';
  readonly text: string;
  readonly at: string;
  readonly brain?: 'llm' | 'rule';
  readonly slotDelta?: Readonly<Record<string, string>>;
  /**
   * Proposals the engine refused, with their reasons.
   *
   * Deliberately surfaced in the transcript viewer (T-105). Watching the engine
   * catch the model is the most persuasive thing in the demo, and it costs
   * nothing to keep because the engine already produces it.
   */
  readonly rejected?: ReadonlyArray<{ readonly reason: string; readonly detail: string }>;
}

export interface BookingRepository {
  readonly kind: 'indexeddb' | 'memory';
  /** True when writes survive a refresh. False in private-mode fallback. */
  readonly persistent: boolean;
  init(): Promise<void>;
  listBookings(): Promise<Booking[]>;
  saveBooking(booking: Booking): Promise<void>;
  saveTranscript(transcript: Transcript): Promise<void>;
  listTranscripts(): Promise<Transcript[]>;
  clear(): Promise<void>;
}

/* ---------------------------------------------------------------- brains -- */

export interface BrainInput {
  /** What the visitor just said, verbatim. */
  readonly text: string;
  /** The engine's state *before* this turn. Read-only to the brain. */
  readonly state: EngineState;
  /** Recent turns, oldest first. The worker truncates this to the last eight. */
  readonly history: readonly TranscriptTurn[];
  readonly locale: string;
}

export interface BrainTurn {
  /**
   * What the brain proposes, as tool calls.
   *
   * Both brains speak to the engine only this way. That symmetry is the
   * architecture made visible: the rule brain is not a lesser path with fewer
   * checks, it is the same path with a different author.
   */
  readonly calls: readonly ToolCall[];
  /**
   * The brain's own wording, when it has one.
   *
   * Advisory. If it does not address the question the engine requires next, the
   * engine's line is spoken instead (plan §7.3, §12.7).
   */
  readonly reply?: string;
  /** True when the brain could make no sense of the turn at all. */
  readonly unparseable?: boolean;
  /** True when the visitor asked something unrelated to booking. */
  readonly offTopic?: boolean;
}

export interface Brain {
  readonly kind: 'llm' | 'rule';
  respond(input: BrainInput, signal?: AbortSignal): Promise<BrainTurn>;
}

/* --------------------------------------------------------------- gateway -- */

export type GatewayMode = 'full' | 'degraded' | 'unreachable';

export interface GatewayStatus {
  readonly mode: GatewayMode;
  readonly reason?: string;
}
