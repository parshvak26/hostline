/**
 * The fixture corpus, replayed (T-032).
 *
 * Plan §12.6 names a dataset and three numbers: ≥60 labelled utterances, ≥15
 * full conversations, task completion ≥90%, mean turns to booking ≤5. This file
 * is where those stop being aspirations. The corpus lives in JSON so it can be
 * read and extended by someone who has never opened `machine.ts`; the assertions
 * live here so that extending it badly fails CI.
 *
 * Two rules the corpus is written under, both load-bearing:
 *
 *   - **Every expectation was run before it was committed.** A fixture file
 *     full of plausible-looking wrong answers is worse than no fixture file,
 *     because it converts a real regression into a green tick.
 *   - **Where the code and the spec disagree, the fixture follows the spec** and
 *     carries `knownGap`. Those are skipped loudly rather than quietly relaxed,
 *     so the gap stays visible in the test output until someone closes it.
 *
 * Conversations are replayed through {@link Conversation} — the same driver the
 * browser and `scripts/converse.ts` use. That is the whole point of the harness:
 * a conversation that passes here passes there, because it is the same code
 * deciding.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import rawConfig from '../../src/config/restaurant.json' with { type: 'json' };
import { validateRestaurantConfig } from '../../src/config/validate.js';
import { buildSeedDiary, toDiaryEntries } from '../../src/config/seed.js';
import { deterministicIds, fixedClock } from '../../src/agent/clock.js';
import { Conversation } from '../../src/agent/session.js';
import { createRuleBrain } from '../../src/agent/brains/rule.js';
import { parseDate } from '../../src/agent/brains/parse/date.js';
import { parseTime } from '../../src/agent/brains/parse/time.js';
import { parseParty } from '../../src/agent/brains/parse/party.js';
import { parseName } from '../../src/agent/brains/parse/name.js';
import { parsePhone } from '../../src/agent/brains/parse/phone.js';
import type { ParseContext, ParseResult } from '../../src/agent/brains/parse/types.js';
import type { EngineDeps, IsoDate, RestaurantConfig, SlotName } from '../../src/engine/index.js';

const CONFIG: RestaurantConfig = validateRestaurantConfig(rawConfig);

/** Matches `tests/helpers/engine.ts`, so both suites mean the same Tuesday. */
const DEFAULT_TODAY: IsoDate = '2026-08-25';
const DEFAULT_NOW_TIME = '18:00';
const NOW_ISO = '2026-08-25T12:30:00.000Z';

const FIXTURES = new URL('../fixtures/', import.meta.url);
const CONVERSATIONS = new URL('conversations/', FIXTURES);

/* ------------------------------------------------------------ utterances -- */

type ExpectedParse =
  | { readonly kind: 'ok'; readonly value: string | number }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly (string | number)[] }
  | { readonly kind: 'none' };

interface UtteranceRow {
  readonly text: string;
  readonly slot: SlotName;
  readonly expect: ExpectedParse;
  /** The date the conversation had already settled on, where that matters. */
  readonly onDate?: IsoDate;
  readonly note?: string;
  readonly knownGap?: boolean;
}

const SLOTS: readonly SlotName[] = ['date', 'time', 'partySize', 'name', 'phone'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runtime shape check.
 *
 * JSON read off disk is `unknown`, and a corpus is exactly the kind of file
 * someone extends by hand at speed. A typo in `slot` would otherwise become an
 * undefined parser and a confusing crash rather than a named failure.
 */
function asUtteranceRow(raw: unknown, index: number): UtteranceRow {
  if (!isRecord(raw)) throw new Error(`utterances[${index}] is not an object`);
  const { text, slot, expect: expected, onDate, note, knownGap } = raw;
  if (typeof text !== 'string' || text === '') throw new Error(`utterances[${index}].text must be a non-empty string`);
  if (typeof slot !== 'string' || !SLOTS.includes(slot as SlotName)) {
    throw new Error(`utterances[${index}].slot is not a slot name: ${String(slot)}`);
  }
  if (!isRecord(expected)) throw new Error(`utterances[${index}].expect is missing`);
  const kind = expected['kind'];
  if (kind !== 'ok' && kind !== 'ambiguous' && kind !== 'none') {
    throw new Error(`utterances[${index}].expect.kind is not ok|ambiguous|none`);
  }
  if (kind === 'ok' && typeof expected['value'] !== 'string' && typeof expected['value'] !== 'number') {
    throw new Error(`utterances[${index}].expect.value must accompany kind "ok"`);
  }
  if (kind === 'ambiguous' && !Array.isArray(expected['candidates'])) {
    throw new Error(`utterances[${index}].expect.candidates must accompany kind "ambiguous"`);
  }
  return {
    text,
    slot: slot as SlotName,
    expect: expected as unknown as ExpectedParse,
    ...(typeof onDate === 'string' ? { onDate } : {}),
    ...(typeof note === 'string' ? { note } : {}),
    ...(knownGap === true ? { knownGap: true } : {}),
  };
}

function loadUtterances(): readonly UtteranceRow[] {
  const raw: unknown = JSON.parse(readFileSync(new URL('utterances.json', FIXTURES), 'utf8'));
  if (!Array.isArray(raw)) throw new Error('utterances.json must be an array');
  return raw.map(asUtteranceRow);
}

const PARSERS: Readonly<Record<SlotName, (text: string, ctx: ParseContext) => ParseResult<string | number>>> = {
  date: parseDate,
  time: parseTime,
  partySize: parseParty,
  name: parseName,
  phone: parsePhone,
};

const UTTERANCES = loadUtterances();

describe('labelled utterances', () => {
  it('meets the size the evaluation plan asks for', () => {
    // Plan §12.6, verbatim: "≥60 labelled utterances". A real gate, not a hint.
    expect(UTTERANCES.length).toBeGreaterThanOrEqual(60);
  });

  it('covers every slot', () => {
    for (const slot of SLOTS) {
      expect(UTTERANCES.filter((u) => u.slot === slot).length).toBeGreaterThan(0);
    }
  });

  it('covers all three parse outcomes', () => {
    for (const kind of ['ok', 'ambiguous', 'none'] as const) {
      expect(UTTERANCES.filter((u) => u.expect.kind === kind).length).toBeGreaterThan(0);
    }
  });

  for (const [index, row] of UTTERANCES.entries()) {
    const title = `${row.slot}: ${JSON.stringify(row.text)}${row.onDate === undefined ? '' : ` (on ${row.onDate})`}`;

    if (row.knownGap === true) {
      // Skipped, not deleted, and skipped with the reason in the title so the
      // gap is legible in CI output rather than buried in a comment.
      it.skip(`${title} — KNOWN GAP: ${row.note ?? 'spec and parser disagree'}`, () => undefined);
      continue;
    }

    it(title, () => {
      const ctx: ParseContext = {
        today: DEFAULT_TODAY,
        nowTime: DEFAULT_NOW_TIME,
        config: CONFIG,
        ...(row.onDate === undefined ? {} : { date: row.onDate }),
      };
      const parser = PARSERS[row.slot];
      const result = parser(row.text, ctx);

      expect(result.kind, `utterances[${index}] ${title}`).toBe(row.expect.kind);
      if (row.expect.kind === 'ok' && result.kind === 'ok') {
        expect(result.value).toBe(row.expect.value);
      }
      if (row.expect.kind === 'ambiguous' && result.kind === 'ambiguous') {
        expect([...result.candidates]).toEqual([...row.expect.candidates]);
      }
    });
  }
});

/* --------------------------------------------------------- conversations -- */

interface ConversationExpectation {
  readonly outcome: 'booked' | 'no_availability' | 'abandoned' | 'escalate' | 'incomplete';
  readonly slots?: Readonly<Record<string, string | number>>;
  /** Each of these must appear among the rejections the engine produced. */
  readonly rejectionReasons?: readonly string[];
  /** Each of these phrase keys must be spoken at least once. */
  readonly lineKeys?: readonly string[];
  readonly minAgentTurns?: number;
}

interface ConversationFixture {
  readonly name: string;
  readonly description: string;
  readonly today: IsoDate;
  readonly nowTime: string;
  readonly seeded: boolean;
  readonly turns: readonly string[];
  readonly expect: ConversationExpectation;
  readonly knownGap?: boolean;
  readonly gapNote?: string;
}

function asConversationFixture(raw: unknown, file: string): ConversationFixture {
  if (!isRecord(raw)) throw new Error(`${file} is not an object`);
  const turns = raw['turns'];
  const expected = raw['expect'];
  if (!Array.isArray(turns) || turns.some((t) => typeof t !== 'string')) {
    throw new Error(`${file}.turns must be an array of strings`);
  }
  if (!isRecord(expected) || typeof expected['outcome'] !== 'string') {
    throw new Error(`${file}.expect.outcome is missing`);
  }
  const name = raw['name'];
  const description = raw['description'];
  if (typeof name !== 'string' || typeof description !== 'string') {
    throw new Error(`${file} needs a name and a one-line description`);
  }
  return {
    name,
    description,
    today: typeof raw['today'] === 'string' ? raw['today'] : DEFAULT_TODAY,
    nowTime: typeof raw['nowTime'] === 'string' ? raw['nowTime'] : DEFAULT_NOW_TIME,
    seeded: raw['seeded'] === true,
    turns: turns as readonly string[],
    expect: expected as unknown as ConversationExpectation,
    ...(raw['knownGap'] === true ? { knownGap: true } : {}),
    ...(typeof raw['gapNote'] === 'string' ? { gapNote: raw['gapNote'] } : {}),
  };
}

function loadConversations(): readonly ConversationFixture[] {
  const files = readdirSync(CONVERSATIONS)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((file) => {
    const raw: unknown = JSON.parse(readFileSync(new URL(file, CONVERSATIONS), 'utf8'));
    const fixture = asConversationFixture(raw, file);
    // The filename is the fixture's identity in a failure report, so the two
    // are not allowed to drift.
    if (`${fixture.name}.json` !== file) throw new Error(`${file} declares name "${fixture.name}"`);
    return fixture;
  });
}

const CONVERSATION_FIXTURES = loadConversations();

interface Replay {
  readonly outcome: string;
  readonly slots: Readonly<Record<string, string | number | undefined>>;
  readonly rejectionReasons: readonly string[];
  readonly lineKeys: readonly string[];
  /**
   * Agent turns spent *getting to* the booking: the greeting and the closing
   * confirmation are not questions, so neither counts. This is the number plan
   * §12.6 caps at five.
   */
  readonly agentTurns: number;
  readonly booked: boolean;
}

/** Wired exactly as `scripts/converse.ts` wires it, minus the terminal. */
async function replay(fixture: ConversationFixture): Promise<Replay> {
  const clock = fixedClock({ date: fixture.today, time: fixture.nowTime, iso: NOW_ISO });
  const deps: EngineDeps = {
    clock,
    config: CONFIG,
    diary: fixture.seeded ? toDiaryEntries(buildSeedDiary(CONFIG, fixture.today, NOW_ISO)) : [],
    ids: deterministicIds(42),
    source: 'typed',
    brain: 'rule',
  };
  const parseContext = (): ParseContext => ({ today: fixture.today, nowTime: fixture.nowTime, config: CONFIG });
  const conversation = new Conversation({ deps, brain: createRuleBrain({ context: parseContext }), parseContext });

  const lineKeys: string[] = [];
  const rejectionReasons: string[] = [];
  let agentTurns = 0;
  let booked = false;

  const greeting = conversation.start();
  lineKeys.push(...greeting.lines.map((l) => l.line.key));

  for (const turn of fixture.turns) {
    if (conversation.finished) break;
    const result = await conversation.submit(turn);
    lineKeys.push(...result.lines.map((l) => l.line.key));
    rejectionReasons.push(...result.rejections.map((r) => r.reason));
    if (result.booking !== undefined) {
      booked = true;
      continue;
    }
    if (result.lines.length > 0) agentTurns += 1;
  }

  const state = conversation.engineState;
  return {
    outcome: state.outcome ?? 'incomplete',
    slots: { ...state.slots } as Readonly<Record<string, string | number | undefined>>,
    rejectionReasons,
    lineKeys,
    agentTurns,
    booked,
  };
}

/** Filled by the replays below; read by the metrics block at the end. */
const measured: { booked: number; expectedBooked: number; turns: number[] } = {
  booked: 0,
  expectedBooked: 0,
  turns: [],
};

describe('fixture conversations', () => {
  it('meets the size the evaluation plan asks for', () => {
    // Plan §12.6, verbatim: "≥15 full conversations".
    expect(CONVERSATION_FIXTURES.length).toBeGreaterThanOrEqual(15);
  });

  for (const fixture of CONVERSATION_FIXTURES) {
    const title = `${fixture.name} — ${fixture.description}`;

    if (fixture.knownGap === true) {
      it.skip(`${title} — KNOWN GAP: ${fixture.gapNote ?? 'spec and engine disagree'}`, () => undefined);
      continue;
    }

    it(title, async () => {
      const result = await replay(fixture);

      if (fixture.expect.outcome === 'booked') {
        measured.expectedBooked += 1;
        if (result.booked) {
          measured.booked += 1;
          measured.turns.push(result.agentTurns);
        }
      }

      expect(result.outcome, `${fixture.name}: outcome`).toBe(fixture.expect.outcome);

      for (const [slot, value] of Object.entries(fixture.expect.slots ?? {})) {
        expect(result.slots[slot], `${fixture.name}: slot ${slot}`).toBe(value);
      }

      for (const reason of fixture.expect.rejectionReasons ?? []) {
        expect(result.rejectionReasons, `${fixture.name}: rejection ${reason}`).toContain(reason);
      }

      for (const key of fixture.expect.lineKeys ?? []) {
        expect(result.lineKeys, `${fixture.name}: line ${key}`).toContain(key);
      }

      if (fixture.expect.minAgentTurns !== undefined) {
        expect(result.agentTurns).toBeGreaterThanOrEqual(fixture.expect.minAgentTurns);
      }
    });
  }
});

/**
 * The published numbers.
 *
 * Ordered last on purpose: Vitest runs `describe` blocks in file order, so by
 * the time these execute every replay above has contributed to `measured`.
 */
describe('evaluation metrics (plan §12.6)', () => {
  it('task completion is at least 90%', () => {
    expect(measured.expectedBooked).toBeGreaterThan(0);
    const rate = measured.booked / measured.expectedBooked;
    console.log(
      `task completion: ${measured.booked}/${measured.expectedBooked} = ${(rate * 100).toFixed(1)}%`,
    );
    expect(rate).toBeGreaterThanOrEqual(0.9);
  });

  it('mean agent turns to booking is at most 5', () => {
    const total = measured.turns.reduce((sum, n) => sum + n, 0);
    const mean = total / measured.turns.length;
    console.log(
      `turns to booking: mean ${mean.toFixed(2)} over ${measured.turns.length} bookings ` +
        `(min ${Math.min(...measured.turns)}, max ${Math.max(...measured.turns)})`,
    );
    expect(mean).toBeLessThanOrEqual(5);
  });
});
