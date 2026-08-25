/**
 * Restaurant config validation (T-008).
 *
 * `restaurant.json` is the only place the restaurant is defined, and every
 * availability decision reads from it. A typo in an opening window would show
 * up as a mysterious "we're closed then" three layers away, so the config is
 * checked once, at startup, and a malformed one throws with a message that says
 * exactly what is wrong.
 *
 * This runs outside `src/engine/` because it is a boundary check on untrusted
 * data, and because the engine takes an already-valid config as a given.
 */

import type { OpeningDay, RestaurantConfig, TableClass, Weekday } from '../engine/types.js';
import { daysInMonth, isClockTime, minutesOf, parseIsoDate, WEEKDAYS } from '../engine/time.js';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(message: string) {
    super(`restaurant.json: ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`"${key}" must be a non-empty string`);
  }
  return value;
}

function requireNumber(source: Record<string, unknown>, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`"${path}" must be a finite number`);
  }
  return value;
}

function requireRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  if (!isRecord(value)) throw new ConfigError(`"${key}" must be an object`);
  return value;
}

function requireArray(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new ConfigError(`"${key}" must be an array`);
  return value;
}

function validateWindows(day: Weekday, raw: unknown): ReadonlyArray<readonly [string, string]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigError(`hours.${day}: an open day needs at least one window`);
  }

  const windows: Array<readonly [string, string]> = [];
  let previousClose = -1;

  raw.forEach((entry, index) => {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new ConfigError(`hours.${day}[${index}]: a window must be exactly ["HH:MM", "HH:MM"]`);
    }
    const [open, close] = entry as unknown[];
    if (typeof open !== 'string' || !isClockTime(open)) {
      throw new ConfigError(`hours.${day}[${index}]: opening time ${JSON.stringify(open)} is not HH:MM`);
    }
    if (typeof close !== 'string' || !isClockTime(close)) {
      throw new ConfigError(`hours.${day}[${index}]: closing time ${JSON.stringify(close)} is not HH:MM`);
    }
    const openMin = minutesOf(open);
    const closeMin = minutesOf(close);
    if (closeMin <= openMin) {
      throw new ConfigError(`hours.${day}[${index}]: closes at ${close}, which is not after ${open}`);
    }
    // Ordered and non-overlapping, so availability can scan them linearly.
    if (openMin < previousClose) {
      throw new ConfigError(`hours.${day}[${index}]: window starting ${open} overlaps or precedes the previous one`);
    }
    previousClose = closeMin;
    windows.push([open, close]);
  });

  return windows;
}

function validateHours(raw: unknown[]): readonly OpeningDay[] {
  const seen = new Set<string>();
  const days: OpeningDay[] = [];

  for (const entry of raw) {
    if (!isRecord(entry)) throw new ConfigError('hours: every entry must be an object');
    const day = entry['day'];
    if (typeof day !== 'string' || !(WEEKDAYS as readonly string[]).includes(day)) {
      throw new ConfigError(`hours: ${JSON.stringify(day)} is not one of ${WEEKDAYS.join(', ')}`);
    }
    if (seen.has(day)) throw new ConfigError(`hours: "${day}" appears more than once`);
    seen.add(day);

    if (entry['closed'] === true) {
      days.push({ day: day as Weekday, closed: true });
      continue;
    }
    days.push({ day: day as Weekday, windows: validateWindows(day as Weekday, entry['windows']) });
  }

  const missing = WEEKDAYS.filter((d) => !seen.has(d));
  if (missing.length > 0) {
    throw new ConfigError(`hours: missing ${missing.join(', ')} — every weekday must be listed`);
  }

  return days;
}

function validateTables(raw: unknown[]): readonly TableClass[] {
  if (raw.length === 0) throw new ConfigError('tables: at least one table class is required');

  const ids = new Set<string>();
  const tables: TableClass[] = [];

  for (const entry of raw) {
    if (!isRecord(entry)) throw new ConfigError('tables: every entry must be an object');
    const id = requireString(entry, 'id');
    if (ids.has(id)) throw new ConfigError(`tables: duplicate table id "${id}"`);
    ids.add(id);

    const seats = requireNumber(entry, 'seats', `tables.${id}.seats`);
    const count = requireNumber(entry, 'count', `tables.${id}.count`);
    if (!Number.isInteger(seats) || seats < 1) {
      throw new ConfigError(`tables.${id}.seats must be a positive integer, got ${seats}`);
    }
    if (!Number.isInteger(count) || count < 1) {
      throw new ConfigError(`tables.${id}.count must be a positive integer, got ${count}`);
    }
    tables.push({ id, seats, count });
  }

  return tables;
}

/**
 * Validates and returns a typed config. Throws {@link ConfigError} on anything
 * malformed — deliberately a throw rather than a result type, because a bad
 * config is a build mistake and there is no sensible way to continue.
 */
export function validateRestaurantConfig(raw: unknown): RestaurantConfig {
  if (!isRecord(raw)) throw new ConfigError('the file must contain a JSON object');

  const id = requireString(raw, 'id');
  const name = requireString(raw, 'name');
  const neighbourhood = requireString(raw, 'neighbourhood');
  const timezone = requireString(raw, 'timezone');
  const established = requireNumber(raw, 'established', 'established');

  const locales = requireArray(raw, 'locales');
  if (locales.length === 0 || !locales.every((l) => typeof l === 'string' && l !== '')) {
    throw new ConfigError('locales must be a non-empty array of locale strings');
  }

  const serviceRaw = requireRecord(raw, 'service');
  const service = {
    slotMinutes: requireNumber(serviceRaw, 'slotMinutes', 'service.slotMinutes'),
    leadTimeMinutes: requireNumber(serviceRaw, 'leadTimeMinutes', 'service.leadTimeMinutes'),
    horizonDays: requireNumber(serviceRaw, 'horizonDays', 'service.horizonDays'),
    maxPartySize: requireNumber(serviceRaw, 'maxPartySize', 'service.maxPartySize'),
    minPartySize: requireNumber(serviceRaw, 'minPartySize', 'service.minPartySize'),
  };

  if (service.slotMinutes <= 0 || 60 % service.slotMinutes !== 0) {
    throw new ConfigError(`service.slotMinutes must divide 60, got ${service.slotMinutes}`);
  }
  if (service.leadTimeMinutes < 0) throw new ConfigError('service.leadTimeMinutes must not be negative');
  if (service.horizonDays < 1) throw new ConfigError('service.horizonDays must be at least 1');
  if (service.minPartySize < 1) throw new ConfigError('service.minPartySize must be at least 1');
  if (service.maxPartySize < service.minPartySize) {
    throw new ConfigError(
      `service.maxPartySize (${service.maxPartySize}) is below minPartySize (${service.minPartySize})`,
    );
  }

  const hours = validateHours(requireArray(raw, 'hours'));
  const tables = validateTables(requireArray(raw, 'tables'));

  const closuresRaw = requireArray(raw, 'closures');
  const closures = closuresRaw.map((entry, index) => {
    if (!isRecord(entry)) throw new ConfigError(`closures[${index}] must be an object`);
    const date = requireString(entry, 'date');
    if (parseIsoDate(date) === null) {
      const civil = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
      const hint =
        civil?.[1] !== undefined && civil[2] !== undefined
          ? ` — ${civil[1]}-${civil[2]} has ${daysInMonth(Number(civil[1]), Number(civil[2]))} days`
          : '';
      throw new ConfigError(`closures[${index}].date "${date}" is not a real calendar date${hint}`);
    }
    return { date, reason: requireString(entry, 'reason') };
  });

  const turnTimesRaw = requireRecord(raw, 'turnTimeMinutes');
  const turnTimeMinutes: Record<string, number> = {};
  for (let size = service.minPartySize; size <= service.maxPartySize; size += 1) {
    const value = turnTimesRaw[String(size)];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new ConfigError(
        `turnTimeMinutes is missing a positive value for party size ${size} — it must cover ${service.minPartySize}..${service.maxPartySize}`,
      );
    }
    if (value % service.slotMinutes !== 0) {
      throw new ConfigError(
        `turnTimeMinutes["${size}"] is ${value}, which is not a multiple of slotMinutes (${service.slotMinutes})`,
      );
    }
    turnTimeMinutes[String(size)] = value;
  }

  const policyRaw = requireRecord(raw, 'policy');
  const combineTables = policyRaw['combineTables'];
  if (typeof combineTables !== 'boolean') throw new ConfigError('policy.combineTables must be a boolean');
  const policy = {
    combineTables,
    lastSeatingBeforeCloseMinutes: requireNumber(
      policyRaw,
      'lastSeatingBeforeCloseMinutes',
      'policy.lastSeatingBeforeCloseMinutes',
    ),
  };
  if (policy.lastSeatingBeforeCloseMinutes < 0) {
    throw new ConfigError('policy.lastSeatingBeforeCloseMinutes must not be negative');
  }

  // With table combining off, a party larger than the biggest table can never be
  // seated. That is a deliberate policy (plan §10.5 step 7) rather than a bug,
  // but it is worth failing loudly if the config makes it true for *every* size.
  const largestTable = tables.reduce((max, t) => Math.max(max, t.seats), 0);
  if (!policy.combineTables && largestTable < service.minPartySize) {
    throw new ConfigError(
      `no table seats ${service.minPartySize} and combineTables is false — nothing could ever be booked`,
    );
  }

  return {
    id,
    name,
    established,
    neighbourhood,
    timezone,
    locales: locales as string[],
    service,
    hours,
    closures,
    tables,
    turnTimeMinutes,
    policy,
  };
}
