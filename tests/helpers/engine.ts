/**
 * Shared test scaffolding for the engine.
 *
 * Every engine test needs the same three things: a clock frozen somewhere
 * sensible, the shipped restaurant config, and a diary. Building those inline in
 * each file is how test suites end up disagreeing about what "Friday" means, so
 * they are built once here.
 *
 * **The pinned date is 2026-08-25, a Tuesday.** Chosen because the week after it
 * contains every case worth testing: a closed Monday, dinner-only Tuesday to
 * Thursday, a Friday with two service windows, and a lunch-only Sunday.
 */

import rawConfig from '../../src/config/restaurant.json' with { type: 'json' };
import { validateRestaurantConfig } from '../../src/config/validate.js';
import { buildSeedDiary, toDiaryEntries } from '../../src/config/seed.js';
import { deterministicIds, fixedClock } from '../../src/agent/clock.js';
import type { DiaryEntry, EngineDeps, EngineEvent, EngineState, IsoDate, RestaurantConfig, ToolCall } from '../../src/engine/index.js';
import { initialState, reduce, weekdayOf } from '../../src/engine/index.js';

export const CONFIG: RestaurantConfig = validateRestaurantConfig(rawConfig);

/** Tuesday. Asserted rather than assumed — see `it('the pinned date …')`. */
export const TODAY: IsoDate = '2026-08-25';
export const NOW_TIME = '18:00';
export const NOW_ISO = '2026-08-25T12:30:00.000Z';

/** The days the suites refer to by name. */
export const MONDAY: IsoDate = '2026-08-31';
export const TUESDAY: IsoDate = '2026-08-25';
export const WEDNESDAY: IsoDate = '2026-08-26';
export const THURSDAY: IsoDate = '2026-08-27';
export const FRIDAY: IsoDate = '2026-08-28';
export const SATURDAY: IsoDate = '2026-08-29';
export const SUNDAY: IsoDate = '2026-08-30';

/** The configured closure, so tests do not hard-code it in two places. */
export const CLOSURE_DATE: IsoDate = CONFIG.closures[0]?.date ?? '2026-10-20';

export interface DepsOptions {
  readonly today?: IsoDate;
  readonly nowTime?: string;
  readonly diary?: readonly DiaryEntry[];
  /** Include the demo diary. Off by default so most tests start from an empty room. */
  readonly seeded?: boolean;
  readonly config?: RestaurantConfig;
  readonly source?: 'voice' | 'typed';
  readonly brain?: 'llm' | 'rule' | 'mixed';
  readonly idSeed?: number;
}

/**
 * Build engine deps.
 *
 * The default is an **empty diary**, so a test that says "this slot is full"
 * had to fill it deliberately. Tests that want the shipped demo diary pass
 * `seeded: true`.
 */
export function makeDeps(options: DepsOptions = {}): EngineDeps {
  const config = options.config ?? CONFIG;
  const today = options.today ?? TODAY;
  const clock = fixedClock({ date: today, time: options.nowTime ?? NOW_TIME, iso: NOW_ISO });

  const diary =
    options.diary ??
    (options.seeded === true ? toDiaryEntries(buildSeedDiary(config, today, NOW_ISO)) : []);

  return {
    clock,
    config,
    diary,
    ids: deterministicIds(options.idSeed ?? 42),
    source: options.source ?? 'typed',
    brain: options.brain ?? 'rule',
  };
}

/** A diary entry, with the turn time filled in from the config. */
export function entry(date: IsoDate, time: string, tableId: string, durationMinutes: number): DiaryEntry {
  return { date, time, tableId, durationMinutes };
}

/** `count` entries on the same table class, all at the same time. */
export function fill(date: IsoDate, time: string, tableId: string, durationMinutes: number, count: number): DiaryEntry[] {
  return Array.from({ length: count }, () => entry(date, time, tableId, durationMinutes));
}

/**
 * Every table of every class, occupied across a wide interval.
 *
 * Used by tests that need "the room is full" without caring how.
 */
export function fullRoom(date: IsoDate, time = '18:30', durationMinutes = 300): DiaryEntry[] {
  return CONFIG.tables.flatMap((t) => fill(date, time, t.id, durationMinutes, t.count));
}

/* --------------------------------------------------------------- driving -- */

/** Fold events into the engine, returning the final result. */
export function run(events: readonly EngineEvent[], deps: EngineDeps, from: EngineState = initialState()) {
  let state = from;
  const effects = [];
  const rejections = [];
  for (const event of events) {
    const result = reduce(state, event, deps);
    state = result.state;
    effects.push(...result.effects);
    rejections.push(...result.rejections);
  }
  return { state, effects, rejections };
}

/** A tool call, in the shape a model emits one. */
export function call(name: string, args: unknown = {}): EngineEvent {
  return { type: 'tool_call', call: { name, arguments: args } as ToolCall };
}

export function turn(text: string): EngineEvent {
  return { type: 'visitor_turn', text };
}

/**
 * Drive the engine to a state where every slot is validated and a read-back has
 * been offered — the doorstep of `commit_booking`.
 *
 * Most adversarial cases need this as their starting point, and building it by
 * hand in each test would make them about setup rather than about the boundary.
 */
export function readyToConfirm(
  deps: EngineDeps,
  overrides: Partial<{ date: IsoDate; time: string; partySize: number; name: string; phone: string }> = {},
) {
  const slots = {
    date: overrides.date ?? FRIDAY,
    time: overrides.time ?? '19:00',
    partySize: overrides.partySize ?? 4,
    name: overrides.name ?? 'Karani',
    phone: overrides.phone ?? '9820011447',
  };
  return run([{ type: 'start' }, turn('yes please'), call('propose_slots', slots)], deps);
}

export { initialState, weekdayOf };
