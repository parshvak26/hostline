/**
 * The chat-model adapter (T-063).
 *
 * Plan §0 picks **Groq** for one measurable reason — time-to-first-token is what
 * buys the sub-second budget in §12.5 — with **Cerebras** and then **Google
 * Gemini Flash** as the documented fallbacks if the free tier moves. All three
 * speak the OpenAI chat-completions dialect, so switching is a change to
 * {@link ENDPOINT} and the request body in this file and nothing else. That is
 * the entire reason this file exists separately from `chat.ts`.
 *
 * It returns the provider's **raw streaming `Response`**. Parsing the SSE it
 * contains belongs to `chat.ts`, because the parser is the part with a bug
 * budget (plan §19, Phase 3) and it should be tested once rather than once per
 * provider.
 *
 * The API key is read here, put into an `Authorization` header, and never
 * placed anywhere a client could see it (plan §13).
 */

import type { Env } from '../types.js';

/** The only message shape that reaches a provider. Content is always a string. */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  /** Already in the provider's wire format — see `toolsForProvider()`. */
  readonly tools: readonly unknown[];
  readonly maxTokens: number;
}

export interface ModelAdapter {
  /** Recorded in `docs/decisions/` alongside the date the free tier was verified. */
  readonly name: string;
  stream(request: ModelRequest, env: Env, signal: AbortSignal): Promise<Response>;
}

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Low but not zero.
 *
 * The engine owns every decision, so variety in the model's wording costs
 * nothing and a completely deterministic host sounds like a phone tree.
 */
const TEMPERATURE = 0.3;

export const modelAdapter: ModelAdapter = {
  name: 'groq',

  stream(request: ModelRequest, env: Env, signal: AbortSignal): Promise<Response> {
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.MODEL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.MODEL_NAME,
        messages: request.messages,
        tools: request.tools,
        // `auto` rather than `required`: plenty of turns are pure conversation
        // ("we're running late"), and forcing a call there produces a fabricated
        // one for the engine to reject.
        tool_choice: 'auto',
        max_tokens: request.maxTokens,
        temperature: TEMPERATURE,
        stream: true,
      }),
      // Passed straight through so a barge-in genuinely cancels the upstream
      // request rather than only abandoning our end of it.
      signal,
    });
  },
};
