#!/usr/bin/env tsx
/**
 * Measure reply latency by replaying the fixture corpus (T-087, T-122).
 *
 * ## The rule this script exists to enforce
 *
 * **No number reaches the README until this has produced it** (plan §15). Every
 * figure it prints names the machine and the conditions it was measured on,
 * because a latency number without those is decoration.
 *
 * ## What it can and cannot measure here
 *
 * It measures the **rule brain** end to end: parse, validate, check
 * availability, choose the next line. That path needs no network and no key, so
 * the number is real, reproducible, and the one that matters most — it is the
 * floor the whole degradation chain rests on, and plan §15 targets it at under
 * 400ms.
 *
 * It **cannot** measure the AI path without a deployed gateway and a provider
 * key, neither of which exist at build time. Rather than estimate, it says so
 * and reports nothing for that column. Plan §12.5 is explicit: publish the
 * honest measured number or explain why there isn't one. Never fake it.
 *
 * ## What is deliberately excluded
 *
 * Synthesis and playback. Those are browser-side and are measured in the
 * browser by the orchestrator's own marks, which feed the on-screen readout.
 * This script measures the part that runs identically everywhere.
 *
 *   npm run measure-latency
 *   npm run measure-latency -- --json
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { argv, stdout, exit, arch, platform, version } from 'node:process';
import { cpus, totalmem } from 'node:os';

import rawConfig from '../src/config/restaurant.json' with { type: 'json' };
import { validateRestaurantConfig } from '../src/config/validate.js';
import { buildSeedDiary, toDiaryEntries } from '../src/config/seed.js';
import { deterministicIds, fixedClock } from '../src/agent/clock.js';
import { Conversation } from '../src/agent/session.js';
import { createRuleBrain } from '../src/agent/brains/rule.js';
import { percentiles } from '../src/agent/orchestrator.js';
import type { ParseContext } from '../src/agent/brains/parse/types.js';
import type { EngineDeps } from '../src/engine/index.js';

const FIXTURES = new URL('../tests/fixtures/conversations/', import.meta.url).pathname;

interface Fixture {
  readonly name: string;
  readonly today?: string;
  readonly nowTime?: string;
  readonly seeded?: boolean;
  readonly turns: readonly string[];
  readonly knownGap?: boolean;
}

const config = validateRestaurantConfig(rawConfig);

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as Fixture)
    .filter((f) => f.knownGap !== true);
}

function depsFor(fixture: Fixture): { deps: EngineDeps; parseContext: () => ParseContext } {
  const today = fixture.today ?? '2026-08-25';
  const nowTime = fixture.nowTime ?? '18:00';
  const clock = fixedClock({ date: today, time: nowTime, iso: `${today}T12:30:00.000Z` });
  const diary = fixture.seeded === true ? toDiaryEntries(buildSeedDiary(config, today, clock.now().iso)) : [];

  return {
    deps: { clock, config, diary, ids: deterministicIds(7), source: 'typed', brain: 'rule' },
    parseContext: () => ({ today, nowTime, config }),
  };
}

async function measure(): Promise<{ samples: number[]; conversations: number; turns: number }> {
  const fixtures = loadFixtures();
  const samples: number[] = [];
  let turns = 0;

  // A warm-up pass. The first run pays for module initialisation and JIT
  // warm-up, and reporting that as the agent's reply latency would overstate it
  // by an order of magnitude.
  for (const fixture of fixtures.slice(0, 3)) {
    const { deps, parseContext } = depsFor(fixture);
    const warm = new Conversation({ deps, brain: createRuleBrain({ context: parseContext }), parseContext });
    warm.start();
    for (const turn of fixture.turns) await warm.submit(turn);
  }

  for (const fixture of fixtures) {
    const { deps, parseContext } = depsFor(fixture);
    const conversation = new Conversation({
      deps,
      brain: createRuleBrain({ context: parseContext }),
      parseContext,
    });
    conversation.start();

    for (const turn of fixture.turns) {
      if (conversation.finished) break;
      const started = performance.now();
      await conversation.submit(turn);
      samples.push(performance.now() - started);
      turns += 1;
    }
  }

  return { samples, conversations: fixtures.length, turns };
}

function environmentLine(): string {
  const model = cpus()[0]?.model ?? 'unknown CPU';
  const gb = Math.round(totalmem() / 1024 ** 3);
  return `${model.trim()}, ${cpus().length} cores, ${gb} GB · ${platform}/${arch} · Node ${version}`;
}

async function main(): Promise<number> {
  const { samples, conversations, turns } = await measure();
  const stats = percentiles(samples.map((s) => Math.round(s * 1000) / 1000));
  const mean = samples.reduce((a, b) => a + b, 0) / (samples.length || 1);
  const max = samples.reduce((a, b) => Math.max(a, b), 0);
  const environment = environmentLine();
  const measuredAt = new Date().toISOString();

  if (argv.includes('--json')) {
    stdout.write(
      `${JSON.stringify(
        {
          measuredAt,
          environment,
          ruleBrain: {
            p50Ms: round(stats.p50),
            p95Ms: round(stats.p95),
            meanMs: round(mean),
            maxMs: round(max),
            samples: samples.length,
            conversations,
            turns,
            targetMs: 400,
            withinTarget: stats.p95 < 400,
          },
          llmBrain: null,
          llmNote:
            'Not measured. The AI path needs a deployed gateway and a provider key, neither of which exists at build time. Run this again after `wrangler deploy` to fill it in.',
          excludes: 'Speech synthesis and playback, which are browser-side and measured by the on-screen readout.',
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  stdout.write(`\nHostline — reply latency, rule brain\n\n`);
  stdout.write(`  measured   ${measuredAt}\n`);
  stdout.write(`  on         ${environment}\n`);
  stdout.write(`  corpus     ${conversations} conversations, ${turns} turns\n\n`);
  stdout.write(`  p50        ${round(stats.p50)} ms\n`);
  stdout.write(`  p95        ${round(stats.p95)} ms\n`);
  stdout.write(`  mean       ${round(mean)} ms\n`);
  stdout.write(`  slowest    ${round(max)} ms\n\n`);
  stdout.write(`  target     p95 under 400 ms (plan §15) — ${stats.p95 < 400 ? 'met' : 'MISSED'}\n\n`);
  stdout.write(`  Excludes speech synthesis and playback, which are browser-side.\n`);
  stdout.write(`  The AI path is not measured here: it needs a deployed gateway and a\n`);
  stdout.write(`  provider key. Run this again after deploying the worker to fill it in.\n\n`);

  return stats.p95 < 400 ? 0 : 1;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

main()
  .then((code) => exit(code))
  .catch((error: unknown) => {
    stdout.write(`measure-latency failed: ${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  });
