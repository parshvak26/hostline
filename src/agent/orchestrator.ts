/**
 * The turn orchestrator (T-046, T-070, T-083, T-085, T-086, T-087).
 *
 * `session.ts` decides *what happens* in a turn. This decides *when*, and it is
 * where the demo either feels alive or feels like a machine. Four mechanisms do
 * almost all of that work:
 *
 *   - **Brain selection and fallback.** Prefer the model; at 400ms play a
 *     prebaked filler so there is never dead air; at 2.5s give up and let the
 *     rule brain finish the turn; after three consecutive failures stop trying
 *     for the rest of the visit (plan §7.5 F3/F4).
 *   - **Sentence chunking.** Cut the model's stream at the first sentence
 *     boundary and start speaking it while the rest is still being generated
 *     (R-21). Most of the perceived speed comes from this, not from the model.
 *   - **Barge-in.** Flush the audio *and* abort the in-flight chat and speech
 *     requests, then discard the partial turn. Stopping only the audio is the
 *     classic mistake — the agent resumes a sentence nobody is listening to
 *     (R-22, T-085).
 *   - **Latency marks.** t0 is end-of-speech; the mark that matters is t0 →
 *     first audible sample. Measured per turn, never estimated (T-087).
 *
 * Nothing here contains a booking rule. If a change to this file affects
 * whether a table can be booked, the change is in the wrong file.
 */

import type {
  AudioQueue,
  Brain,
  BookingRepository,
  SpeechInput,
  SpeechOutput,
  Transcript,
  TranscriptTurn,
} from './ports.js';
import type { Booking, EngineDeps, EngineState, PhraseKey, SlotName, SlotState } from '../engine/index.js';
import type { ParseContext } from './brains/parse/types.js';
import { Conversation, type SpokenLine, type TurnOutcome } from './session.js';
import { LISTENING, SPEECH, TURN } from '../config/settings.js';
import { variantFor } from '../config/phrases.js';

/* ---------------------------------------------------------------- events -- */

export type OrchestratorEvent =
  | { readonly type: 'state'; readonly state: EngineState }
  | { readonly type: 'agent_line'; readonly text: string; readonly key: PhraseKey }
  | { readonly type: 'visitor_interim'; readonly text: string }
  | { readonly type: 'visitor_final'; readonly text: string }
  | { readonly type: 'slot'; readonly slot: SlotName; readonly state: SlotState }
  | { readonly type: 'phase'; readonly phase: TalkState }
  | { readonly type: 'latency'; readonly ms: number }
  | { readonly type: 'brain'; readonly brain: 'llm' | 'rule' }
  | { readonly type: 'mode'; readonly ruleMode: boolean }
  | { readonly type: 'booked'; readonly booking: Booking }
  | { readonly type: 'offer_typing' }
  | { readonly type: 'ended'; readonly outcome: string };

/** Drives the Talk button's label and visual (plan §5.3). */
export type TalkState = 'idle' | 'warming' | 'listening' | 'thinking' | 'speaking';

export interface OrchestratorOptions {
  readonly deps: EngineDeps;
  readonly ruleBrain: Brain;
  /** Absent when the site was built without a gateway, which is a valid state. */
  readonly llmBrain?: Brain;
  readonly speech: SpeechOutput;
  readonly audio: AudioQueue;
  readonly input?: SpeechInput;
  readonly repository: BookingRepository;
  readonly parseContext: () => ParseContext;
  readonly locale?: string;
  readonly onEvent: (event: OrchestratorEvent) => void;
}

/** A sentence boundary that is not a decimal point or an abbreviation. */
const SENTENCE_END = /[.!?](?:\s|$)/;

/**
 * Accumulate streamed tokens and hand back complete sentences as they form.
 *
 * This is the mechanism behind R-21, and most of the perceived speed comes from
 * it: the agent starts speaking its first sentence while the model is still
 * writing the second. Kept as a standalone function so the ordering can be
 * asserted in a test without a model in the loop.
 */
export function createSentenceStream(onSentence: (sentence: string) => void): {
  push(token: string): void;
  flush(): void;
} {
  let buffer = '';

  return {
    push(token: string): void {
      buffer += token;
      // Cut at the *last* complete boundary in the buffer, so a burst of tokens
      // containing two sentences emits both rather than holding one back.
      while (hasSentenceBoundary(buffer)) {
        const match = SENTENCE_END.exec(buffer);
        if (match === null) break;
        const end = match.index + 1;
        const sentence = buffer.slice(0, end).trim();
        buffer = buffer.slice(end);
        if (sentence !== '') onSentence(sentence);
      }
    },
    flush(): void {
      const rest = buffer.trim();
      buffer = '';
      if (rest !== '') onSentence(rest);
    },
  };
}

export class Orchestrator {
  private conversation: Conversation;
  private talkState: TalkState = 'idle';
  private listening = false;

  /** Aborts everything belonging to the current turn. Replaced each turn. */
  private turnAbort: AbortController | null = null;

  private brainFailures = 0;
  private ruleModeUntil = 0;
  private readonly latencies: number[] = [];
  private turnStartedAt = 0;
  private firstAudioMarked = false;
  private fillerTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPlayedFiller: PhraseKey | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private turnIndex = 0;
  private startedAt = '';

  constructor(private readonly options: OrchestratorOptions) {
    this.conversation = this.newConversation();
  }

  private newConversation(): Conversation {
    return new Conversation({
      deps: this.options.deps,
      brain: this.currentBrain(),
      parseContext: this.options.parseContext,
      ...(this.options.locale === undefined ? {} : { locale: this.options.locale }),
    });
  }

  get state(): EngineState {
    return this.conversation.engineState;
  }

  get transcript(): readonly TranscriptTurn[] {
    return this.conversation.transcript;
  }

  /** True when the model is unavailable and the rule brain is running things. */
  get ruleMode(): boolean {
    return this.options.llmBrain === undefined || Date.now() < this.ruleModeUntil;
  }

  /**
   * Give up on the model for this visit.
   *
   * Called when the gateway is configured but a session could not be
   * established — no Turnstile token, the day's ceiling reached, or the worker
   * unreachable. Distinct from "no gateway configured" only in that it can be
   * re-probed later.
   */
  forceRuleMode(): void {
    this.ruleModeUntil = Date.now() + TURN.reprobeGatewayMs;
    this.emit({ type: 'mode', ruleMode: true });
  }

  /**
   * Microphone energy crossed the barge-in threshold (R-22).
   *
   * Only meaningful while the agent is the one talking — energy during the
   * visitor's own turn is simply the visitor's turn, and interrupting there
   * would cut them off mid-sentence.
   */
  onMicrophoneEnergy(): void {
    if (this.talkState === 'speaking') this.interrupt();
  }

  private currentBrain(): Brain {
    const llm = this.options.llmBrain;
    return llm === undefined || this.ruleMode ? this.options.ruleBrain : llm;
  }

  private emit(event: OrchestratorEvent): void {
    this.options.onEvent(event);
  }

  private setTalkState(next: TalkState): void {
    if (this.talkState === next) return;
    this.talkState = next;
    this.emit({ type: 'phase', phase: next });
  }

  /* ------------------------------------------------------------ warm-up -- */

  /**
   * Everything that can be done before the visitor presses the button (R-24).
   *
   * Called during idle after first contentful paint, while the hero is being
   * read. None of it is on the critical path, and every part is allowed to fail.
   */
  async warm(): Promise<void> {
    this.setTalkState('warming');
    await Promise.allSettled([this.options.speech.warm?.(), this.options.repository.init()]);
    this.setTalkState('idle');
  }

  /* -------------------------------------------------------------- start -- */

  /** Begin a conversation. Must be called from a user gesture (audio unlock). */
  async begin(): Promise<void> {
    this.startedAt = this.options.deps.clock.now().iso;

    // Started inside the gesture — which is what browsers require — but
    // deliberately **not awaited**. Whether the speaker works has no bearing on
    // whether the conversation can begin, and on a machine with no audio device
    // waiting for it means the greeting never appears and the button never
    // leaves `idle`. Audio is a rung that is allowed to fail.
    void this.options.audio.unlock();

    const opening = this.conversation.start();
    this.emit({ type: 'state', state: this.conversation.engineState });

    // The greeting and the microphone start together.
    //
    // Waiting for the agent to finish its own sentence before it will listen
    // adds the whole length of the greeting to the time before a visitor can
    // say anything — and on a machine whose speaker does not work, adds the
    // entire speech ceiling. Recognition is muted while the agent talks
    // (`speakAll`), so opening it early costs nothing and buys a microphone
    // that is live the moment the page is.
    const greeting = this.speakAll(opening.lines);
    await this.listen();
    await greeting;
  }

  /** Start listening, if a microphone path exists. */
  async listen(): Promise<void> {
    const input = this.options.input;
    if (input === undefined) {
      this.setTalkState('idle');
      return;
    }
    if (this.listening) return;

    this.listening = true;
    this.setTalkState('listening');

    await input.start({
      onTranscript: (event) => {
        // Interim only, including for a final result.
        //
        // The endpointer turns that same final into `onEndOfSpeech`, and
        // `handleTurn` is what commits the visitor's line to the transcript.
        // Emitting `visitor_final` here as well printed every spoken turn
        // twice — the two paths are the same event arriving by two routes, and
        // only one of them should be the one that writes.
        this.emit({ type: 'visitor_interim', text: event.text });
      },
      onEndOfSpeech: (text) => {
        void this.handleTurn(text);
      },
      onError: (error) => {
        // Every recognition failure ends in the same place: typing, which is a
        // first-class path rather than a consolation (plan §14).
        this.listening = false;
        if (error.kind === 'permission_denied' || error.kind === 'no_microphone' || error.kind === 'not_supported') {
          this.emit({ type: 'offer_typing' });
          this.setTalkState('idle');
        }
      },
    });

    this.armIdlePrompt();
  }

  stopListening(): void {
    this.listening = false;
    this.options.input?.stop();
    this.clearIdlePrompt();
  }

  /* --------------------------------------------------------------- turn -- */

  /** One visitor turn, spoken or typed. Typed input goes through here too. */
  async handleTurn(text: string): Promise<void> {
    if (this.conversation.finished) return;
    if (text.trim() === '') return;

    this.clearIdlePrompt();
    this.turnIndex += 1;

    // t0. Everything published as "reply latency" is measured from this line.
    this.turnStartedAt = performance.now();
    this.firstAudioMarked = false;

    this.cancelTurn();
    const abort = new AbortController();
    this.turnAbort = abort;

    this.emit({ type: 'visitor_final', text });
    this.setTalkState('thinking');
    this.options.input?.setMuted(true);

    this.armFiller(abort.signal);

    let outcome: TurnOutcome;
    const brain = this.currentBrain();
    this.emit({ type: 'brain', brain: brain.kind });

    try {
      outcome = await this.withBrainTimeout(text, abort.signal);
      if (brain.kind === 'llm') this.brainFailures = 0;
    } catch {
      if (abort.signal.aborted) return;

      // The model failed or timed out. The rule brain finishes this turn so the
      // visitor never learns anything went wrong (plan §7.5 F4).
      this.brainFailures += 1;
      if (this.brainFailures >= TURN.failuresBeforeRuleMode) {
        this.ruleModeUntil = Date.now() + TURN.reprobeGatewayMs;
        this.emit({ type: 'mode', ruleMode: true });
      }
      outcome = await this.finishWithRuleBrain(text, abort.signal);
    }

    this.clearFiller();
    if (abort.signal.aborted) return;

    for (const effect of outcome.effects) {
      if (effect.type === 'announce') this.emit({ type: 'slot', slot: effect.slot, state: effect.state });
      if (effect.type === 'offer_typing') this.emit({ type: 'offer_typing' });
    }

    // What happened comes before how it sounds.
    //
    // The screen, the stored booking and the transcript are all settled before
    // a single word is synthesised. Speaking is the one part of a turn that
    // depends on a platform we do not control — a machine with no audio device,
    // a browser with no installed voices, an OS speech service that has wedged —
    // and none of those may be allowed to delay the visitor seeing that their
    // table is booked.
    //
    // This was not academic: on Linux the CI runner's Firefox has no speech
    // service, `speechSynthesis` never fired `onend`, and the confirmation card
    // sat hidden behind an `await` until the watchdog fired. Twenty-three tests
    // failed for a reason that had nothing to do with booking a table.
    this.emit({ type: 'state', state: outcome.state });

    if (outcome.booking !== undefined) {
      await this.options.repository.saveBooking(outcome.booking).catch(() => undefined);
      this.emit({ type: 'booked', booking: outcome.booking });
    }

    await this.persistTranscript(outcome);
    await this.speakAll(outcome.lines, abort.signal);

    if (outcome.outcome !== undefined) {
      this.emit({ type: 'ended', outcome: outcome.outcome });
      this.stopListening();
      this.setTalkState('idle');
      return;
    }

    this.options.input?.setMuted(false);
    this.setTalkState(this.listening ? 'listening' : 'idle');
    this.armIdlePrompt();
  }

  /**
   * Run the brain with a deadline.
   *
   * The deadline is the point at which waiting longer costs more than a slightly
   * plainer answer. 2.5s is generous — the filler has already been playing for
   * two of those seconds, so the visitor is not sitting in silence.
   */
  private async withBrainTimeout(text: string, signal: AbortSignal): Promise<TurnOutcome> {
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('brain_timeout')), TURN.brainTimeoutMs);
      signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    });

    return Promise.race([this.conversation.submit(text, signal), timeout]);
  }

  /**
   * Finish a turn the model could not.
   *
   * The conversation object is shared, so the rule brain picks up the same
   * engine state — a turn that started on the model and ended on the rules is
   * not a restart, and the booking is marked `mixed` accordingly.
   */
  private async finishWithRuleBrain(text: string, signal: AbortSignal): Promise<TurnOutcome> {
    return this.conversation.submitWith(this.options.ruleBrain, text, signal);
  }

  /* -------------------------------------------------------------- speech -- */

  /**
   * Say everything the engine required, under a hard ceiling.
   *
   * The ceiling is belt to the ordering's braces. Every speech path is supposed
   * to settle — the cascade falls through its rungs, the browser adapter has its
   * own per-utterance watchdog — but "supposed to" is doing a lot of work when
   * the failure mode is a platform call that never returns. The turn loop is
   * allowed to give up on being heard; it is not allowed to stop.
   */
  private async speakAll(lines: readonly SpokenLine[], signal?: AbortSignal): Promise<void> {
    const spoken = (async (): Promise<void> => {
      // R-25, and the reason the microphone can be opened before the agent has
      // finished talking: recognition is deaf for as long as there is a voice
      // coming out of the speaker.
      this.options.input?.setMuted(true);
      try {
        for (const line of lines) {
          if (signal?.aborted === true) return;
          await this.speak(line, signal);
        }
      } finally {
        this.options.input?.setMuted(false);
      }
    })();

    let ceiling: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      ceiling = setTimeout(resolve, SPEECH.turnSpeechCeilingMs);
    });

    await Promise.race([spoken, budget]);
    if (ceiling !== undefined) clearTimeout(ceiling);
  }

  private async speak(line: SpokenLine, signal?: AbortSignal): Promise<void> {
    if (line.text.trim() === '') return;

    this.setTalkState('speaking');
    this.emit({ type: 'agent_line', text: line.text, key: line.line.key });

    // Chunked at sentence boundaries so the first sentence reaches the speaker
    // while the rest is still being synthesised (T-083).
    for (const chunk of splitSentences(line.text)) {
      if (signal?.aborted === true) return;
      try {
        const clip = await this.options.speech.resolve(
          {
            text: chunk,
            ...(chunk === line.text ? { phraseKey: line.line.key, variant: variantFor(line.line.key, this.turnIndex) } : {}),
            locale: this.options.locale ?? 'en-IN',
          },
          signal,
        );

        if (clip.audio !== null) await this.options.audio.enqueue(clip.audio);
        else await this.options.speech.speak?.({ text: chunk, locale: this.options.locale ?? 'en-IN' }, signal);

        this.markFirstAudio();
      } catch {
        // The cascade has already exhausted every rung. Silence for one line is
        // survivable; the text is on screen either way.
        return;
      }
    }
  }

  /** Record t0 → first audible sample, once per turn. */
  private markFirstAudio(): void {
    if (this.firstAudioMarked || this.turnStartedAt === 0) return;
    this.firstAudioMarked = true;
    const ms = Math.round(performance.now() - this.turnStartedAt);
    this.latencies.push(ms);
    this.emit({ type: 'latency', ms });
  }

  /* -------------------------------------------------------------- filler -- */

  /**
   * Never leave dead air (R-23).
   *
   * At 400ms a short prebaked line plays — "let me check" — and the visitor's
   * sense of how long they waited is anchored to that rather than to silence.
   * Never twice in a row, because a filler that repeats is worse than a pause.
   */
  private armFiller(signal: AbortSignal): void {
    this.clearFiller();
    this.fillerTimer = setTimeout(() => {
      if (signal.aborted) return;
      const key: PhraseKey = this.lastPlayedFiller === 'filler_checking' ? 'filler_moment' : 'filler_checking';
      this.lastPlayedFiller = key;
      void this.speak({ line: { key, params: {} }, text: fillerText(key) }, signal);
    }, TURN.fillerAfterMs);
  }

  /** Public form of {@link clearFiller}, for the brain's first-token hook. */
  cancelFiller(): void {
    this.clearFiller();
  }

  private clearFiller(): void {
    if (this.fillerTimer !== null) {
      clearTimeout(this.fillerTimer);
      this.fillerTimer = null;
    }
  }

  /* ------------------------------------------------------------ barge-in -- */

  /**
   * The visitor started talking over the agent (R-22, T-085).
   *
   * Three things happen, and the order matters: stop the sound first because
   * that is what the visitor perceives, then abort the upstream work so no more
   * of it arrives, then drop the partial turn so nothing stale resumes.
   */
  interrupt(): void {
    this.options.audio.flush();
    this.options.speech.cancel();
    this.cancelTurn();
    this.clearFiller();
    this.options.input?.setMuted(false);
    this.setTalkState(this.listening ? 'listening' : 'idle');
  }

  private cancelTurn(): void {
    this.turnAbort?.abort();
    this.turnAbort = null;
  }

  /* --------------------------------------------------------------- idle -- */

  private armIdlePrompt(): void {
    this.clearIdlePrompt();
    if (!this.listening) return;
    this.idleTimer = setTimeout(() => {
      if (!this.listening || this.conversation.finished) return;
      void this.speak({ line: { key: 'still_there', params: {} }, text: 'Still there?' });
      // A second silence ends the listening session rather than leaving the
      // microphone open indefinitely (plan §4.3).
      this.idleTimer = setTimeout(() => this.stopListening(), LISTENING.idleGiveUpMs);
    }, LISTENING.idlePromptMs);
  }

  private clearIdlePrompt(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /* ---------------------------------------------------------- transcript -- */

  private async persistTranscript(outcome: TurnOutcome): Promise<void> {
    const transcript: Transcript = {
      id: `transcript-${this.startedAt}`,
      ...(outcome.booking === undefined ? {} : { bookingId: outcome.booking.id }),
      startedAt: this.startedAt,
      endedAt: this.options.deps.clock.now().iso,
      locale: this.options.locale ?? 'en-IN',
      turns: this.conversation.transcript,
      ...(outcome.outcome === undefined ? {} : { outcome: outcome.outcome }),
      latencies: [...this.latencies],
    };
    await this.options.repository.saveTranscript(transcript).catch(() => undefined);
  }

  /* -------------------------------------------------------------- stats -- */

  /** p50 and p95 of t0 → first audio, for the readout and `measure-latency`. */
  latencyStats(): { p50: number; p95: number; count: number } {
    return percentiles(this.latencies);
  }
}

/* --------------------------------------------------------------- helpers -- */

/**
 * Split a line into speakable chunks at sentence boundaries.
 *
 * Short trailing fragments are folded back into the previous chunk: a
 * two-word sentence synthesised on its own sounds clipped, and the round trip
 * costs more than it saves.
 */
export function splitSentences(text: string, minChars = SPEECH.minSentenceChars): string[] {
  const parts: string[] = [];
  let current = '';

  for (const token of text.split(/(?<=[.!?])\s+/)) {
    if (current === '') current = token;
    else if (current.length < minChars) current = `${current} ${token}`;
    else {
      parts.push(current);
      current = token;
    }
  }
  if (current !== '') parts.push(current);

  return parts.length === 0 ? [text] : parts;
}

export function percentiles(values: readonly number[]): { p50: number; p95: number; count: number } {
  if (values.length === 0) return { p50: 0, p95: 0, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number): number => {
    const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
    return sorted[index] ?? 0;
  };
  return { p50: at(0.5), p95: at(0.95), count: sorted.length };
}

/** True when a stream has produced a complete sentence worth speaking. */
export function hasSentenceBoundary(buffer: string, minChars = SPEECH.minSentenceChars): boolean {
  return buffer.length >= minChars && SENTENCE_END.test(buffer);
}

function fillerText(key: PhraseKey): string {
  return key === 'filler_moment' ? 'Bear with me.' : 'Let me check.';
}
