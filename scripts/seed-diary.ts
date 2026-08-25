#!/usr/bin/env tsx
/**
 * Print the demo diary and check the moment it exists for (T-034).
 *
 * The seeding logic itself lives in `src/config/seed.ts`, because it has to run
 * in the browser on first load and relative to the real clock — a diary pinned
 * to a fixed date would quietly become a list of bookings in the past
 * (ADR-0005). This is the command-line view of it.
 *
 * The check at the end is the one that matters: **19:00 on the next Friday must
 * be unavailable for a party of four, with exactly three alternatives.** That is
 * the designed demo moment, and it is arithmetic rather than arrangement — move
 * the seeded times and the number changes.
 *
 *   npm run seed
 */

import { exit, stdout } from 'node:process';

import rawConfig from '../src/config/restaurant.json' with { type: 'json' };
import { validateRestaurantConfig } from '../src/config/validate.js';
import { buildSeedDiary, nextFriday, toDiaryEntries } from '../src/config/seed.js';
import { deterministicIds, systemClock } from '../src/agent/clock.js';
import { checkAvailability, formatDateLong, formatTime12 } from '../src/engine/index.js';
import type { EngineDeps } from '../src/engine/index.js';

const config = validateRestaurantConfig(rawConfig);
const clock = systemClock(config.timezone);
const today = clock.now().date;
const bookings = buildSeedDiary(config, today, clock.now().iso);

const deps: EngineDeps = {
  clock,
  config,
  diary: toDiaryEntries(bookings),
  ids: deterministicIds(1),
  source: 'typed',
  brain: 'rule',
};

stdout.write(`\n${config.name} — seeded diary (${bookings.length} bookings)\n\n`);

let currentDate = '';
for (const booking of [...bookings].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))) {
  if (booking.date !== currentDate) {
    currentDate = booking.date;
    stdout.write(`  ${formatDateLong(booking.date)}\n`);
  }
  stdout.write(
    `    ${formatTime12(booking.time).padStart(8)}  ${booking.name.padEnd(12)} ` +
      `${String(booking.partySize).padStart(2)}  ${booking.tableId}  (${booking.durationMinutes}m)\n`,
  );
}

const friday = nextFriday(today);
const result = checkAvailability({ date: friday, time: '19:00', partySize: 4 }, deps);

stdout.write(`\n  The demo moment — ${formatDateLong(friday)} at 7:00 pm, party of four:\n`);

if (result.available) {
  stdout.write(`    AVAILABLE (table ${result.tableId}) — the demo moment is broken.\n`);
  stdout.write(`    The seeded bookings no longer fill every four- and six-top at that hour.\n\n`);
  exit(1);
}

stdout.write(`    refused: ${result.rejection.reason}\n`);
stdout.write(`    alternatives: ${result.alternatives.map((a) => formatTime12(a.time)).join(', ')}\n`);

const two = checkAvailability({ date: friday, time: '19:00', partySize: 2 }, deps);
stdout.write(`\n  A party of two at the same slot: ${two.available ? 'available' : 'refused'}`);
stdout.write(` — correct, the two-tops are free.\n`);

if (result.alternatives.length !== 3) {
  stdout.write(`\n  Expected exactly 3 alternatives, got ${result.alternatives.length}.\n\n`);
  exit(1);
}

stdout.write(`\n  Exactly three alternatives, as designed.\n\n`);
exit(0);
