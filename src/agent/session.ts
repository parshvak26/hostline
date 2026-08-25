/**
 * The conversation, with no audio and no browser.
 *
 * Everything about a turn that is *not* about sound lives here: feed the
 * visitor's words to a brain, route the brain's proposals through the engine,
 * and collect the lines the agent must say. `orchestrator.ts` wraps this with
 * recognition, speech, timers and barge-in; `scripts/converse.ts` wraps it with
 * a terminal; the fixture harness wraps it with assertions.
 *
 * Keeping them on one implementation is what makes the fixture corpus worth
 * anything — a conversation that passes in the harness passes in the browser,
 * because it is the same code deciding.
 *
 * ## The rule the whole design turns on
 *
 * The brain's `reply` text is advisory. The engine's lines are not. If a model
 * writes a charming sentence that does not ask the question the engine requires
 * next, the engine's line is spoken instead (plan §7.3, §12.7). This file is
 * where that is enforced, in {@link chooseSpokenLines}.
 */

import type { AgentLine, EngineDeps, EngineState, Effect, Rejection, Booking } from '../engine/index.js';
import { initialState, reduce } from '../engine/index.js';
import type { Brain, BrainTurn, TranscriptTurn } from './ports.js';
import type { ParseContext } from './brains/parse/types.js';
import { ambiguities } from './brains/rule.js';
import { renderPhrase } from '../config/phrases.js';

export interface SpokenLine {
  readonly line: AgentLine;
  readonly text: string;
}

export interface TurnOutcome {
  readonly lines: readonly SpokenLine[];
  readonly state: EngineState;
  readonly rejections: readonly Rejection[];
  readonly effects: readonly Effect[];
  readonly brain: 'llm' | 'rule';
  /** Set when this turn committed a booking. */
  readonly booking?: Booking;
  /** Set when the conversation finished on this turn. */
  readonly outcome?: string;
}

export interface SessionOptions {
  readonly deps: EngineDeps;
  readonly brain: Brain;
  /** Used to give the parsers today's date without them reading a clock. */
  readonly parseContext: () => ParseContext;
  readonly locale?: string;
}

/**
 * Render an engine line into words.
 *
 * The seed is the turn number, so a conversation replays identically while
 * still varying its wording across turns — which is what the fixture corpus and
 * the latency replay both need.
 */
function render(line: AgentLine, seed: number): SpokenLine {
  return { line, text: renderPhrase(line.key, line.params, seed) };
}

/** Every `say` effect the engine produced, in order. */
function linesFrom(effects: readonly Effect[], seed: number): SpokenLine[] {
  return effects.filter((e): e is Extract<Effect, { type: 'say' }> => e.type === 'say').map((e) => render(e.line, seed));
}

/**
 * Decide what is actually spoken.
 *
 * The brain's own wording is used only when it exists *and* the engine did not
 * require something specific — which in practice means the model gets to phrase
 * the conversational turns and the engine keeps the ones that carry facts.
 */
export function chooseSpokenLines(engineLines: readonly SpokenLine[], turn: BrainTurn): readonly SpokenLine[] {
  if (engineLines.length > 0) return engineLines;
  if (turn.reply !== undefined && turn.reply.trim() !== '') {
    return [{ line: { key: 'not_understood', params: {} }, text: turn.reply.trim() }];
  }
  return [];
}

export class Conversation {
  private state: EngineState = initialState();
  private turnIndex = 0;
  private readonly history: TranscriptTurn[] = [];

  constructor(private readonly options: SessionOptions) {}

  get engineState(): EngineState {
    return this.state;
  }

  get transcript(): readonly TranscriptTurn[] {
    return this.history;
  }

  get finished(): boolean {
    return this.state.phase === 'committed' || this.state.phase === 'ended';
  }

  /** Play the greeting. Returns the lines to speak. */
  start(): TurnOutcome {
    const result = reduce(this.state, { type: 'start' }, this.options.deps);
    this.state = result.state;
    const lines = linesFrom(result.effects, this.turnIndex);
    this.record('agent', lines, result);
    return this.outcome(lines, result.effects, result.rejections, 'rule');
  }

  /** One visitor turn, start to finish, using the configured brain. */
  async submit(text: string, signal?: AbortSignal): Promise<TurnOutcome> {
    return this.submitWith(this.options.brain, text, signal);
  }

  /**
   * One visitor turn, using a specific brain.
   *
   * The orchestrator uses this to finish a turn with the rule brain when the
   * model timed out mid-turn. The engine state is shared, so the fallback picks
   * up exactly where the model left off — a turn that starts on the model and
   * ends on the rules is a continuation, not a restart (plan §7.5 F4).
   */
  async submitWith(brain: Brain, text: string, signal?: AbortSignal): Promise<TurnOutcome> {
    this.turnIndex += 1;
    this.history.push({ role: 'visitor', text, at: this.options.deps.clock.now().iso });

    // The engine sees the visitor's raw words first, and classifies agreement
    // and abandonment from them itself. A brain never gets to assert "they said
    // yes" — that is adversarial case 3, closed at the source.
    let result = reduce(this.state, { type: 'visitor_turn', text }, this.options.deps);
    this.state = result.state;

    const effects: Effect[] = [...result.effects];
    const rejections: Rejection[] = [...result.rejections];

    if (this.finished) {
      const lines = linesFrom(effects, this.turnIndex);
      this.record('agent', lines, { effects, rejections });
      return this.outcome(lines, effects, rejections, brain.kind);
    }

    const turn = await brain.respond(
      { text, state: this.state, history: this.history, locale: this.options.locale ?? 'en-IN' },
      signal,
    );

    // Ambiguity is a question the agent asks, not a value it invents. Handled
    // before the tool calls, because a parser that returned candidates did not
    // return a proposal for that slot.
    const unresolved = this.disambiguation(text, turn);
    if (unresolved !== null) {
      this.record('agent', [unresolved], { effects, rejections });
      return this.outcome([unresolved], effects, rejections, brain.kind);
    }

    for (const call of turn.calls) {
      result = reduce(this.state, { type: 'tool_call', call }, this.options.deps);
      this.state = result.state;
      effects.push(...result.effects);
      rejections.push(...result.rejections);
    }

    if (turn.calls.length === 0) {
      const event = turn.offTopic === true ? ({ type: 'off_topic' } as const) : ({ type: 'no_input' } as const);
      if (turn.unparseable === true || turn.offTopic === true) {
        result = reduce(this.state, event, this.options.deps);
        this.state = result.state;
        effects.push(...result.effects);
        rejections.push(...result.rejections);
      }
    }

    const engineLines = linesFrom(effects, this.turnIndex);
    const lines = chooseSpokenLines(engineLines, turn);
    this.record('agent', lines, { effects, rejections }, brain.kind);

    return this.outcome(lines, effects, rejections, brain.kind);
  }

  /**
   * Ask which of two readings the visitor meant.
   *
   * Only when the slot in question is still outstanding — a parser reporting an
   * ambiguity about a slot the brain nonetheless resolved is not a question
   * worth asking.
   */
  private disambiguation(text: string, turn: BrainTurn): SpokenLine | null {
    if (turn.calls.length > 0) return null;
    const found = ambiguities(text, this.options.parseContext());
    for (const [slot, candidates] of Object.entries(found)) {
      if (candidates === undefined || candidates.length < 2) continue;
      const state = this.state.slotStates[slot as keyof typeof this.state.slotStates];
      if (state === 'validated' || state === 'confirmed') continue;
      const options = candidates.map((c) => String(c));
      const last = options[options.length - 1] ?? '';
      return render(
        { key: 'ask_disambiguate', params: { options: `${options.slice(0, -1).join(', ')} or ${last}`, slot } },
        this.turnIndex,
      );
    }
    return null;
  }

  private record(
    role: 'agent',
    lines: readonly SpokenLine[],
    source: { effects: readonly Effect[]; rejections: readonly Rejection[] },
    brainKind: 'llm' | 'rule' = this.options.brain.kind,
  ): void {
    if (lines.length === 0 && source.rejections.length === 0) return;
    const text = lines.map((l) => l.text).join(' ');
    const rejected = source.rejections.map((r) => ({ reason: r.reason, detail: r.detail }));
    this.history.push({
      role,
      text,
      at: this.options.deps.clock.now().iso,
      brain: brainKind,
      ...(rejected.length > 0 ? { rejected } : {}),
    });
  }

  private outcome(
    lines: readonly SpokenLine[],
    effects: readonly Effect[],
    rejections: readonly Rejection[],
    brain: 'llm' | 'rule',
  ): TurnOutcome {
    const commit = effects.find((e): e is Extract<Effect, { type: 'commit' }> => e.type === 'commit');
    const end = effects.find((e): e is Extract<Effect, { type: 'end' }> => e.type === 'end');
    return {
      lines,
      state: this.state,
      rejections,
      effects,
      brain,
      ...(commit === undefined ? {} : { booking: commit.booking }),
      ...(end === undefined ? {} : { outcome: end.outcome }),
    };
  }
}
