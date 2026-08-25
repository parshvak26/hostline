#!/usr/bin/env tsx
/**
 * Book a table from the terminal (T-035).
 *
 * No browser, no microphone, no network, no model — just the rule brain and the
 * engine. If this completes a booking, the whole of Phase 1 works, and CI uses
 * it as a smoke test for exactly that reason.
 *
 * It is also the fastest way to feel what the fallback path is actually like.
 * Everything a visitor gets in "simple mode" is here, in plain text.
 *
 *   npm run converse                      interactive
 *   npm run converse -- --script "..."    one utterance per `|`, non-interactive
 *   npm run converse -- --demo            the scripted happy path
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, exit } from 'node:process';

import rawConfig from '../src/config/restaurant.json' with { type: 'json' };
import { validateRestaurantConfig } from '../src/config/validate.js';
import { buildSeedDiary, toDiaryEntries, nextFriday } from '../src/config/seed.js';
import { deterministicIds, systemClock, systemIds } from '../src/agent/clock.js';
import { Conversation } from '../src/agent/session.js';
import { createRuleBrain } from '../src/agent/brains/rule.js';
import type { ParseContext } from '../src/agent/brains/parse/types.js';
import type { EngineDeps } from '../src/engine/index.js';
import { formatDateLong, formatTime12 } from '../src/engine/index.js';

const DIM = '[2m';
const BOLD = '[1m';
const RESET = '[0m';

const config = validateRestaurantConfig(rawConfig);
const deterministic = argv.includes('--deterministic');
const clock = systemClock(config.timezone);
const today = clock.now().date;
const seeded = buildSeedDiary(config, today, clock.now().iso);

const deps: EngineDeps = {
  clock,
  config,
  diary: toDiaryEntries(seeded),
  ids: deterministic ? deterministicIds(11) : systemIds(),
  source: 'typed',
  brain: 'rule',
};

const parseContext = (): ParseContext => ({
  today: clock.now().date,
  nowTime: clock.now().time,
  config,
});

const conversation = new Conversation({
  deps,
  brain: createRuleBrain({ context: parseContext }),
  parseContext,
});

function speak(lines: readonly { text: string }[]): void {
  for (const line of lines) {
    if (line.text.trim() === '') continue;
    stdout.write(`${BOLD}host${RESET}  ${line.text}\n`);
  }
}

function showRejections(rejections: readonly { reason: string; detail: string }[]): void {
  // Surfaced deliberately. Watching the engine refuse a proposal is the most
  // persuasive thing in this project, and it should be visible here too.
  for (const r of rejections) {
    stdout.write(`${DIM}      engine refused: ${r.reason} — ${r.detail}${RESET}\n`);
  }
}

function showSlots(): void {
  const { slots, slotStates } = conversation.engineState;
  const row = (label: string, value: string | number | undefined, state: string): string => {
    const mark = state === 'confirmed' ? '✓' : state === 'validated' ? '·' : ' ';
    return `${mark} ${label.padEnd(7)} ${value ?? '—'}`;
  };
  stdout.write(
    `${DIM}${[
      row('date', slots.date === undefined ? undefined : formatDateLong(slots.date), slotStates.date),
      row('time', slots.time === undefined ? undefined : formatTime12(slots.time), slotStates.time),
      row('guests', slots.partySize, slotStates.partySize),
      row('name', slots.name, slotStates.name),
      row('phone', slots.phone, slotStates.phone),
    ].join('\n')}${RESET}\n`,
  );
}

async function run(): Promise<number> {
  stdout.write(`\n${BOLD}${config.name}${RESET} ${DIM}· ${config.neighbourhood} · rule brain, no network${RESET}\n`);
  stdout.write(`${DIM}Next Friday is ${formatDateLong(nextFriday(today))}; 19:00 is deliberately full.${RESET}\n\n`);

  speak(conversation.start().lines);

  const scriptFlag = argv.indexOf('--script');
  const demo = argv.includes('--demo');

  const scripted: string[] | null = demo
    ? demoScript()
    : scriptFlag >= 0
      ? (argv[scriptFlag + 1] ?? '').split('|').map((s) => s.trim()).filter((s) => s !== '')
      : null;

  if (scripted !== null) {
    for (const utterance of scripted) {
      if (conversation.finished) break;
      stdout.write(`${DIM}you${RESET}   ${utterance}\n`);
      const result = await conversation.submit(utterance);
      showRejections(result.rejections);
      speak(result.lines);
    }
  } else {
    const rl = createInterface({ input: stdin, output: stdout });
    while (!conversation.finished) {
      const answer = await rl.question(`${DIM}you${RESET}   `);
      if (answer.trim() === '/slots') {
        showSlots();
        continue;
      }
      if (answer.trim() === '/quit') break;
      const result = await conversation.submit(answer);
      showRejections(result.rejections);
      speak(result.lines);
    }
    rl.close();
  }

  stdout.write('\n');
  showSlots();

  const booking = conversation.engineState.committed;
  if (booking !== undefined) {
    stdout.write(
      `\n${BOLD}Booked${RESET} ${booking.reference} — ${formatDateLong(booking.date)} at ` +
        `${formatTime12(booking.time)}, ${booking.partySize} guests, table ${booking.tableId}\n\n`,
    );
    return 0;
  }

  stdout.write(`\n${DIM}No booking made (outcome: ${conversation.engineState.outcome ?? 'incomplete'}).${RESET}\n\n`);
  return conversation.engineState.outcome === undefined ? 1 : 0;
}

/**
 * The scripted happy path, used by CI.
 *
 * Deliberately awkward in the same ways a real person is. In order, it exercises
 * two details in one breath, the seeded-full 19:00 slot and the alternatives it
 * produces, a spelled-out phone number, and — the interesting one — a party-size
 * correction *after* the read-back, which must void the confirmation, re-check
 * availability at the new size, and ask again.
 */
function demoScript(): string[] {
  return [
    'hi, do you have a table for four on friday',
    'seven pm',
    'quarter past eight then',
    "it's under Karani",
    'nine eight two zero zero double one four four seven',
    'actually make it five',
    'half past eight',
    'yes please',
  ];
}

run()
  .then((code) => exit(code))
  .catch((error: unknown) => {
    stdout.write(`\nconverse failed: ${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  });
