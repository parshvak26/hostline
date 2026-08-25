/**
 * The tool schema (T-067).
 *
 * The tools are the model's entire vocabulary, and this file is the consistency
 * check that stops that vocabulary drifting away from the engine that has to
 * honour it. Two assertions carry most of the weight:
 *
 *   - **`PROPOSABLE_FIELDS` equals `SLOT_ORDER`.** The schema and the
 *     validators name the same five fields or the model is being invited to
 *     propose something nothing will ever accept. TypeScript cannot see this —
 *     one side is a JSON-shaped object literal, the other is a runtime array —
 *     so it has to be asserted.
 *   - **`commit_booking` takes no properties at all.** Not "optional
 *     properties", not "ignored properties": none. That is the structural
 *     reason a model cannot hallucinate a complete booking (plan §12.3, R-40),
 *     and `Object.keys(...).length === 0` is the whole of the guarantee.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PROPOSABLE_FIELDS, TOOLS, TOOL_NAMES, toolsForProvider } from '../../src/agent/brains/tools.js';
import { SLOT_ORDER } from '../../src/engine/index.js';

/** The `ToolName` union, read from the source — a type cannot be enumerated. */
function toolNamesDeclaredInTypes(): readonly string[] {
  const source = readFileSync(new URL('../../src/engine/types.ts', import.meta.url), 'utf8');
  const union = /export type ToolName =([\s\S]*?);/.exec(source);
  if (union === null) throw new Error('could not find the ToolName union in src/engine/types.ts');
  return [...(union[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('the tool vocabulary', () => {
  it('is exactly the ToolName union, with nothing extra and nothing missing', () => {
    expect([...TOOL_NAMES].sort()).toEqual([...toolNamesDeclaredInTypes()].sort());
  });

  it('is five tools', () => {
    expect(TOOLS.length).toBe(5);
    expect(new Set(TOOL_NAMES).size).toBe(5);
  });

  it('declares no tool that writes anything by itself', () => {
    // There is deliberately no `create_booking`, `cancel_booking` or
    // `update_diary`. Every write goes through the engine's own commit path.
    for (const name of TOOL_NAMES) {
      expect(name).not.toMatch(/^(create|write|update|delete|cancel)_/);
    }
  });
});

describe('propose_slots', () => {
  const proposeSlots = TOOLS.find((t) => t.name === 'propose_slots');

  it('exists', () => {
    expect(proposeSlots).toBeDefined();
  });

  it('accepts exactly the slots the engine validates', () => {
    // If this fails, the schema and `src/engine/validate.ts` have drifted and
    // one of them is now lying to the model. Fix the code, not this test.
    expect(PROPOSABLE_FIELDS).toEqual(SLOT_ORDER);
  });

  it('requires nothing, because a visitor rarely says everything at once', () => {
    expect(proposeSlots?.parameters.required).toBeUndefined();
  });
});

describe('the tools that carry no arguments', () => {
  for (const name of ['request_confirmation', 'commit_booking'] as const) {
    it(`${name} has no properties at all`, () => {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool, `${name} is missing`).toBeDefined();
      // The structural guarantee, stated as plainly as it can be: there is
      // nowhere for a hallucinated booking to go.
      expect(Object.keys(tool?.parameters.properties ?? { placeholder: null }).length).toBe(0);
      expect(tool?.parameters.required).toBeUndefined();
    });
  }
});

describe('every tool schema', () => {
  for (const tool of TOOLS) {
    it(`${tool.name} is a closed object`, () => {
      expect(tool.parameters.type).toBe('object');
      // An open schema is an invitation to send a field nobody validates.
      expect(tool.parameters.additionalProperties).toBe(false);
    });

    it(`${tool.name} only requires fields it declares`, () => {
      for (const field of tool.parameters.required ?? []) {
        expect(Object.keys(tool.parameters.properties), `${tool.name}.${field}`).toContain(field);
      }
    });

    it(`${tool.name} describes every property it accepts`, () => {
      for (const [field, schema] of Object.entries(tool.parameters.properties)) {
        expect(schema.type, `${tool.name}.${field}`).not.toBe('');
        expect(schema.description.trim(), `${tool.name}.${field}`).not.toBe('');
        if (schema.pattern !== undefined) expect(() => new RegExp(schema.pattern ?? '')).not.toThrow();
      }
    });

    it(`${tool.name} promises nothing the engine does not enforce`, () => {
      // Descriptions are prompt hygiene, not a control — but a description that
      // tells the model it can book a table is the one kind of copy that makes
      // the model confidently wrong out loud.
      const lower = tool.description.toLowerCase();
      for (const claim of ['will book', 'will confirm', 'guarantees', 'guaranteed', 'always succeeds']) {
        expect(lower, `${tool.name}: "${tool.description}"`).not.toContain(claim);
      }
    });
  }
});

describe('toolsForProvider', () => {
  const wire: readonly unknown[] = toolsForProvider();

  it('emits one OpenAI-compatible function per tool', () => {
    expect(wire.length).toBe(TOOLS.length);

    for (const [index, entry] of wire.entries()) {
      expect(isRecord(entry)).toBe(true);
      if (!isRecord(entry)) continue;

      expect(entry['type']).toBe('function');

      const fn = entry['function'];
      expect(isRecord(fn)).toBe(true);
      if (!isRecord(fn)) continue;

      const tool = TOOLS[index];
      expect(fn['name']).toBe(tool?.name);
      expect(fn['description']).toBe(tool?.description);
      expect(fn['parameters']).toEqual(tool?.parameters);
    }
  });

  it('carries nothing beyond the wire shape', () => {
    for (const entry of wire) {
      if (!isRecord(entry)) continue;
      expect(Object.keys(entry).sort()).toEqual(['function', 'type']);
    }
  });
});
