/**
 * The LLM brain (T-068).
 *
 * Deliberately the same shape as `rule.ts`: same {@link Brain} interface, same
 * `BrainTurn` out, same single route into the engine. A reviewer putting the two
 * files side by side should see that neither has more authority than the other —
 * that symmetry *is* the architecture (plan §9).
 *
 * What this file does **not** do is worth listing, because it is the whole
 * design:
 *
 *   - It does not decide availability. It can ask; the engine answers.
 *   - It does not write a booking. `commit_booking` takes no arguments, so there
 *     is nowhere to put one.
 *   - It does not parse its own tool arguments into state. They are forwarded to
 *     the engine exactly as they arrived — **including when they are malformed**,
 *     because the engine is built to reject those with a typed reason and
 *     repairing them here would hide a real model failure (adversarial case 12).
 *
 * The system prompt is not here either. It lives in the worker (§12.4), so a
 * visitor cannot rewrite the agent's instructions by editing a request.
 */

import type { Brain, BrainInput, BrainTurn, TranscriptTurn } from '../ports.js';
import type { ToolCall } from '../../engine/index.js';
import type { GatewayClient } from '../../gateway/client.js';
import { TURN } from '../../config/settings.js';

export interface LlmBrainOptions {
  readonly client: GatewayClient;
  /**
   * Called with each token as it streams.
   *
   * The orchestrator uses this to cut at the first sentence boundary and start
   * speaking before generation finishes (R-21, T-083) — which is where most of
   * the perceived speed comes from.
   */
  readonly onToken?: (text: string) => void;
  /** Called once the first token arrives, to cancel the pending filler. */
  readonly onFirstToken?: () => void;
}

/** The last eight turns, in the shape the worker expects. */
function toMessages(history: readonly TranscriptTurn[]): Array<{ role: string; content: string }> {
  return history
    .slice(-TURN.maxTurns * 2)
    .filter((turn) => turn.text.trim() !== '')
    .map((turn) => ({ role: turn.role === 'agent' ? 'assistant' : 'user', content: turn.text }));
}

export function createLlmBrain(options: LlmBrainOptions): Brain {
  return {
    kind: 'llm',

    async respond(input: BrainInput, signal?: AbortSignal): Promise<BrainTurn> {
      const controller = new AbortController();
      const forward = (): void => controller.abort();
      signal?.addEventListener('abort', forward, { once: true });

      const calls: ToolCall[] = [];
      let reply = '';
      let sawFirstToken = false;

      try {
        const stream = options.client.chat(
          {
            messages: [...toMessages(input.history), { role: 'user', content: input.text }],
            // Sent so the worker can build an accurate prompt. It is a
            // description of what the engine already knows, not an instruction —
            // the engine re-derives everything from its own copy regardless.
            engineState: summariseState(input),
            locale: input.locale,
          },
          controller.signal,
        );

        for await (const event of stream) {
          if (controller.signal.aborted) break;

          if (event.type === 'token') {
            if (!sawFirstToken) {
              sawFirstToken = true;
              options.onFirstToken?.();
            }
            reply += event.text;
            options.onToken?.(event.text);
            continue;
          }

          if (event.type === 'tool_call') {
            // Forwarded verbatim. `name` may be nonsense and `arguments` may be
            // a raw string; both are cases the engine has typed rejections for.
            calls.push({ name: event.name, arguments: event.arguments });
            continue;
          }

          if (event.type === 'done') break;
        }
      } finally {
        signal?.removeEventListener('abort', forward);
      }

      const trimmed = reply.trim();

      // A model that produced neither words nor a tool call has failed the turn.
      // The orchestrator treats that as a brain failure and lets the rule brain
      // finish, rather than leaving the visitor with silence (plan §7.5 F4).
      if (calls.length === 0 && trimmed === '') return { calls: [], unparseable: true };

      return { calls, ...(trimmed === '' ? {} : { reply: trimmed }) };
    },
  };
}

/**
 * What the model is told about the engine's state.
 *
 * Only the facts it needs in order to phrase a good question: what is known,
 * what is still missing, and where the conversation is. Sending the whole state
 * would invite the model to reason about internals it has no authority over.
 */
function summariseState(input: BrainInput): Record<string, unknown> {
  const { slots, slotStates, phase, alternatives } = input.state;
  const outstanding = (['date', 'time', 'partySize', 'name', 'phone'] as const).filter(
    (slot) => slotStates[slot] !== 'validated' && slotStates[slot] !== 'confirmed',
  );

  return {
    phase,
    known: {
      date: slots.date ?? null,
      time: slots.time ?? null,
      partySize: slots.partySize ?? null,
      name: slots.name ?? null,
      // The number itself is never sent to the model. It has no use for it, and
      // the less of the visitor's data that leaves the device the better.
      phone: slots.phone === undefined ? null : `ending ${slots.phone.slice(-4)}`,
    },
    stillNeeded: outstanding,
    alternativesOffered: alternatives.map((a) => `${a.date} ${a.time}`),
  };
}
