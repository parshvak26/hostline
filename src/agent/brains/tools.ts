/**
 * The tool schema (T-067) — the model's entire vocabulary.
 *
 * These five definitions are shared between the browser (which sends them) and
 * the worker (which injects the system prompt describing them). Sharing one
 * source is what stops the schema and the engine's validators drifting apart;
 * `tests/unit/tools.test.ts` asserts they still agree.
 *
 * ## The part that matters
 *
 * There is no tool that writes anything. `commit_booking` takes **no
 * arguments** — deliberately. It cannot carry a date, a time, or a party size,
 * because there is nothing for the model to assert: the engine re-derives every
 * field from its own state. A model that hallucinates a complete booking has
 * nowhere to put it (plan §12.3, R-40).
 *
 * The descriptions are written for the model, so they say plainly that
 * availability is not its decision. That is prompt hygiene rather than a
 * control — the control is `src/engine/machine.ts`, which does not read them.
 */

import type { ToolName } from '../../engine/index.js';

export interface ToolParameterSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, { type: string; description: string; pattern?: string }>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface ToolDefinition {
  readonly name: ToolName;
  readonly description: string;
  readonly parameters: ToolParameterSchema;
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'propose_slots',
    description:
      'Report details the visitor has just given. Include only fields they actually said in this turn. ' +
      'These are proposals: the booking system validates each one independently and may reject any of them.',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'The date as YYYY-MM-DD, resolved against today. Omit if the visitor did not give one.',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        },
        time: {
          type: 'string',
          description: 'The time as HH:MM in 24-hour form, on a 15-minute boundary.',
          pattern: '^\\d{2}:\\d{2}$',
        },
        partySize: { type: 'integer', description: 'Number of guests, as a whole number.' },
        name: { type: 'string', description: 'The name for the booking. Letters, spaces, hyphens and apostrophes only.' },
        phone: { type: 'string', description: 'The phone number as digits.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'check_availability',
    description:
      'Ask whether a table is free. You do not decide this and must never tell the visitor a table is ' +
      'available before the system has answered. Your arguments are treated as a hint only.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD.', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        time: { type: 'string', description: 'HH:MM, 24-hour.', pattern: '^\\d{2}:\\d{2}$' },
        partySize: { type: 'integer', description: 'Number of guests.' },
      },
      required: ['date', 'time', 'partySize'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_confirmation',
    description:
      'Ask the system to read the booking back to the visitor. Only useful once all five details are in; ' +
      'it is refused otherwise.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'commit_booking',
    description:
      'Ask the system to make the booking. It takes no arguments, because the system uses its own record ' +
      'of the details rather than anything you supply. It will refuse unless it has read the booking back ' +
      'and the visitor agreed in their own words.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'escalate',
    description: 'End the conversation politely when it cannot be completed here, such as a very large group.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'A short machine-readable reason.' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

/** The wire format most OpenAI-compatible providers expect, including Groq. */
export function toolsForProvider(): unknown[] {
  return TOOLS.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export const TOOL_NAMES: readonly ToolName[] = TOOLS.map((t) => t.name);

/** The slot fields `propose_slots` accepts. Asserted against the engine's list. */
export const PROPOSABLE_FIELDS: readonly string[] = Object.keys(
  TOOLS.find((t) => t.name === 'propose_slots')?.parameters.properties ?? {},
);
