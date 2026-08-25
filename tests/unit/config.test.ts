/**
 * T-008 — `restaurant.json` and its validator.
 *
 * The config is the single definition of the restaurant, and every availability
 * decision reads from it. A typo in an opening window would surface three
 * layers away as a mysterious "we're closed then", so the acceptance criterion
 * is not merely that a bad config throws: it is that each *kind* of bad config
 * throws a message that names the thing that is wrong. The distinct-message
 * assertion at the end of this file is what keeps that honest — a validator
 * that collapsed to one generic error would still throw, and would still be
 * useless.
 */

import { describe, expect, it } from 'vitest';

import rawConfig from '../../src/config/restaurant.json' with { type: 'json' };
import { ConfigError, validateRestaurantConfig } from '../../src/config/validate.js';

/**
 * A deliberately loose mirror of the config, so a test can put a broken value
 * where a valid one belongs without fighting the shipped type.
 */
interface LooseConfig {
  service: Record<string, number>;
  hours: Array<{ day: string; closed?: boolean; windows?: string[][] }>;
  tables: Array<{ id: string; seats: number; count: number }>;
  closures: Array<{ date: string; reason: string }>;
  turnTimeMinutes: Record<string, number>;
  policy: Record<string, unknown>;
  [key: string]: unknown;
}

/** Deep clone, so one broken variant cannot leak into the next. */
function clone(): LooseConfig {
  return JSON.parse(JSON.stringify(rawConfig)) as LooseConfig;
}

/** Run the validator and return the message of the ConfigError it must throw. */
function messageFrom(broken: LooseConfig): string {
  try {
    validateRestaurantConfig(broken);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ConfigError);
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected validateRestaurantConfig to throw, but it accepted the config');
}

/** Replace one weekday's entry, leaving the rest of the week alone. */
function withDay(config: LooseConfig, day: string, replacement: LooseConfig['hours'][number]): LooseConfig {
  config.hours = config.hours.map((entry) => (entry.day === day ? replacement : entry));
  return config;
}

describe('the shipped config', () => {
  it('validates', () => {
    expect(() => validateRestaurantConfig(rawConfig)).not.toThrow();
  });

  it('comes back typed, with the values the engine suites assume', () => {
    const config = validateRestaurantConfig(rawConfig);
    expect(config.id).toBe('ember-and-oak');
    expect(config.service).toEqual({
      slotMinutes: 15,
      leadTimeMinutes: 30,
      horizonDays: 60,
      maxPartySize: 8,
      minPartySize: 1,
    });
    expect(config.hours).toHaveLength(7);
    expect(config.tables).toEqual([
      { id: 'T2', seats: 2, count: 6 },
      { id: 'T4', seats: 4, count: 5 },
      { id: 'T6', seats: 6, count: 2 },
    ]);
    expect(config.policy.combineTables).toBe(false);
    expect(config.policy.lastSeatingBeforeCloseMinutes).toBe(60);
  });

  it('covers every party size in range with a turn time', () => {
    const config = validateRestaurantConfig(rawConfig);
    for (let size = config.service.minPartySize; size <= config.service.maxPartySize; size += 1) {
      expect(config.turnTimeMinutes[String(size)]).toBeGreaterThan(0);
    }
  });

  it('is not mistaken for valid when it is not an object at all', () => {
    expect(() => validateRestaurantConfig(null)).toThrow(ConfigError);
    expect(() => validateRestaurantConfig([])).toThrow(ConfigError);
    expect(() => validateRestaurantConfig('restaurant')).toThrow(ConfigError);
  });
});

/**
 * Each of these breaks exactly one thing. Every message is captured so the
 * final case can assert they are all different from one another.
 */
describe('malformed variants, each rejected on its own terms', () => {
  const messages: string[] = [];
  const record = (message: string): string => {
    messages.push(message);
    return message;
  };

  it('rejects a window that closes before it opens', () => {
    const broken = withDay(clone(), 'tue', { day: 'tue', windows: [['22:30', '18:30']] });
    const message = record(messageFrom(broken));
    expect(message).toContain('hours.tue[0]');
    expect(message).toContain('not after');
  });

  it('rejects two windows on one day that overlap', () => {
    // Availability scans windows linearly and assumes they are ordered and
    // disjoint; an overlap would make "which window am I in" ambiguous.
    const broken = withDay(clone(), 'fri', {
      day: 'fri',
      windows: [
        ['12:30', '15:00'],
        ['14:00', '23:00'],
      ],
    });
    const message = record(messageFrom(broken));
    expect(message).toContain('hours.fri[1]');
    expect(message).toContain('overlaps');
  });

  it('rejects a missing weekday', () => {
    // A day that is simply absent must not silently mean "closed" — that is
    // the difference between a policy and a typo.
    const broken = clone();
    broken.hours = broken.hours.filter((entry) => entry.day !== 'sun');
    const message = record(messageFrom(broken));
    expect(message).toContain('missing sun');
  });

  it('rejects a weekday listed twice', () => {
    const broken = clone();
    broken.hours = [...broken.hours, { day: 'tue', windows: [['12:30', '15:00']] }];
    const message = record(messageFrom(broken));
    expect(message).toContain('"tue" appears more than once');
  });

  it('rejects a duplicate table id', () => {
    // Two classes sharing an id would make the overlap count meaningless: the
    // allocator counts diary entries by table id.
    const broken = clone();
    broken.tables = [...broken.tables, { id: 'T2', seats: 8, count: 1 }];
    const message = record(messageFrom(broken));
    expect(message).toContain('duplicate table id "T2"');
  });

  it('rejects a turn time missing for a party size inside the range', () => {
    const broken = clone();
    delete broken.turnTimeMinutes['5'];
    const message = record(messageFrom(broken));
    expect(message).toContain('party size 5');
  });

  it('rejects a closure date that is not a real calendar date', () => {
    const broken = clone();
    broken.closures = [{ date: '2026-02-30', reason: 'Diwali' }];
    const message = record(messageFrom(broken));
    expect(message).toContain('2026-02-30');
    expect(message).toContain('not a real calendar date');
    // The hint is what makes the message actionable rather than merely correct.
    expect(message).toContain('28 days');
  });

  it('rejects a maximum party size below the minimum', () => {
    const broken = clone();
    broken.service['maxPartySize'] = 0;
    const message = record(messageFrom(broken));
    expect(message).toContain('maxPartySize');
    expect(message).toContain('minPartySize');
  });

  it('rejects a slot length that does not divide an hour', () => {
    // Seven-minute slots would put bookable times at 18:37 and 18:44, which no
    // one says out loud and which the alternatives search steps straight past.
    const broken = clone();
    broken.service['slotMinutes'] = 7;
    const message = record(messageFrom(broken));
    expect(message).toContain('slotMinutes must divide 60');
  });

  it('rejects a turn time that is not a multiple of the slot length', () => {
    const broken = clone();
    broken.turnTimeMinutes['2'] = 100;
    const message = record(messageFrom(broken));
    expect(message).toContain('not a multiple of slotMinutes');
  });

  it('rejects a table with a non-positive seat count', () => {
    const broken = clone();
    broken.tables = broken.tables.map((table) => (table.id === 'T4' ? { ...table, seats: 0 } : table));
    const message = record(messageFrom(broken));
    expect(message).toContain('tables.T4.seats');
  });

  it('rejects an open day with no windows at all', () => {
    const broken = withDay(clone(), 'wed', { day: 'wed', windows: [] });
    const message = record(messageFrom(broken));
    expect(message).toContain('hours.wed');
    expect(message).toContain('at least one window');
  });

  it('gave every one of those a distinct message', () => {
    // The point of the whole block: twelve different mistakes, twelve different
    // things to read. A shared message would mean the validator can tell you
    // that something is wrong but not what.
    expect(messages).toHaveLength(12);
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) {
      expect(message.startsWith('restaurant.json: ')).toBe(true);
    }
  });
});

describe('field-level guards', () => {
  it('names the field when a required string is missing', () => {
    const broken = clone();
    delete broken['name'];
    expect(() => validateRestaurantConfig(broken)).toThrow(/"name"/);
  });

  it('requires locales to be a non-empty array of strings', () => {
    const broken = clone();
    broken['locales'] = [];
    expect(() => validateRestaurantConfig(broken)).toThrow(/locales/);
  });

  it('requires policy.combineTables to be a boolean, not a truthy string', () => {
    const broken = clone();
    broken.policy['combineTables'] = 'false';
    expect(() => validateRestaurantConfig(broken)).toThrow(/combineTables must be a boolean/);
  });

  it('rejects a negative lead time', () => {
    const broken = clone();
    broken.service['leadTimeMinutes'] = -30;
    expect(() => validateRestaurantConfig(broken)).toThrow(/leadTimeMinutes/);
  });

  it('rejects a horizon shorter than a day', () => {
    const broken = clone();
    broken.service['horizonDays'] = 0;
    expect(() => validateRestaurantConfig(broken)).toThrow(/horizonDays/);
  });

  it('rejects a window that is not a two-element pair', () => {
    const broken = withDay(clone(), 'thu', { day: 'thu', windows: [['18:30']] });
    expect(() => validateRestaurantConfig(broken)).toThrow(/exactly \["HH:MM", "HH:MM"\]/);
  });

  it('rejects a window time that is not HH:MM', () => {
    const broken = withDay(clone(), 'thu', { day: 'thu', windows: [['6:30pm', '22:30']] });
    expect(() => validateRestaurantConfig(broken)).toThrow(/is not HH:MM/);
  });

  it('rejects a day name that is not a weekday', () => {
    const broken = withDay(clone(), 'thu', { day: 'thurs', windows: [['18:30', '22:30']] });
    expect(() => validateRestaurantConfig(broken)).toThrow(/is not one of/);
  });

  it('rejects a room with no tables', () => {
    const broken = clone();
    broken.tables = [];
    expect(() => validateRestaurantConfig(broken)).toThrow(/at least one table class/);
  });

  it('rejects a room whose largest table cannot seat the smallest party', () => {
    // With combining off this config could never take a booking at all, which
    // is worth failing at startup rather than at the first request.
    const broken = clone();
    broken.tables = [{ id: 'T1', seats: 1, count: 4 }];
    broken.service['minPartySize'] = 2;
    broken.service['maxPartySize'] = 2;
    expect(() => validateRestaurantConfig(broken)).toThrow(/nothing could ever be booked/);
  });

  it('carries the file name in every message, so the error says where to look', () => {
    const broken = clone();
    delete broken['timezone'];
    expect(() => validateRestaurantConfig(broken)).toThrow(/^restaurant\.json: /);
  });
});
