#!/usr/bin/env tsx
/**
 * Prebake the agent's fixed lines into audio (T-081).
 *
 * ## Why this exists
 *
 * The sub-second target in plan §12.5 does not survive synthesising every line
 * at runtime. Synthesis costs 200–400ms on a good day, which is most of the
 * budget spent on a sentence the agent says in every single conversation.
 *
 * So the fixed lines are synthesised **once, here, at build time**, committed as
 * Opus, and served from the same origin as the page. A turn served from the
 * cache costs **0ms of synthesis**. That is the single largest lever in the
 * latency budget, and it also cuts runtime provider calls by roughly half,
 * which is what keeps the free tier from being the constraint.
 *
 * Only lines with no placeholders can be baked — the read-back contains the
 * visitor's own name and will always be synthesised live. `bakeablePhrases()`
 * decides; there is no separate list to keep in step.
 *
 * ## Running it
 *
 *   export GROQ_API_KEY=...          # never committed, never in the bundle
 *   npm run bake-audio
 *
 * The key is read from the environment and used only here, on the operator's
 * own machine. It never reaches the browser and never reaches the repository.
 * `scripts/check-phrase-coverage.mjs` then verifies the result on every push.
 *
 * Until this has been run, the site is fully functional — the browser's own
 * voice speaks every line. The cache is a speed feature, not a dependency.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit, stdout } from 'node:process';

import { bakeablePhrases } from '../src/config/phrases.js';

const OUT_DIR = new URL('../public/audio/', import.meta.url).pathname;

/**
 * Provider settings.
 *
 * Groq's PlayAI TTS is the plan's choice (§0), behind one constant so that
 * swapping providers is a two-line change here and a two-line change in
 * `worker/src/providers/tts.ts`. If the free tier has moved, plan §0's fallback
 * order is Cloudflare Workers AI, then Gemini TTS.
 */
const PROVIDER = {
  url: 'https://api.groq.com/openai/v1/audio/speech',
  model: env['HOSTLINE_TTS_MODEL'] ?? 'playai-tts',
  voice: env['HOSTLINE_TTS_VOICE'] ?? 'Celeste-PlayAI',
  /** Opus at roughly 24kbps mono keeps the whole cache under 300KB. */
  format: 'opus',
} as const;

interface ClipRecord {
  readonly file: string;
  /** Hash of the *text*, so a reworded line invalidates its clip. */
  readonly hash: string;
  readonly bytes: number;
  readonly text: string;
}

interface Manifest {
  readonly generatedAt: string;
  readonly provider: string;
  readonly model: string;
  readonly voice: string;
  readonly clips: Record<string, ClipRecord>;
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

async function synthesise(text: string, apiKey: string): Promise<ArrayBuffer> {
  const response = await fetch(PROVIDER.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: PROVIDER.model,
      voice: PROVIDER.voice,
      input: text,
      response_format: PROVIDER.format,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}${detail === '' ? '' : ` — ${detail.slice(0, 200)}`}`);
  }

  return response.arrayBuffer();
}

async function main(): Promise<number> {
  const apiKey = env['GROQ_API_KEY'] ?? env['TTS_API_KEY'] ?? '';
  const dryRun = argv.includes('--dry-run');
  const phrases = bakeablePhrases();

  if (apiKey === '' && !dryRun) {
    stdout.write(
      'No GROQ_API_KEY (or TTS_API_KEY) in the environment.\n\n' +
        `${phrases.length} phrase(s) are ready to bake. Set the key and run again:\n\n` +
        '  export GROQ_API_KEY=your-key-here\n' +
        '  npm run bake-audio\n\n' +
        'The site works without this. Every line is spoken by the browser\'s own\n' +
        'voice until the cache exists; baking only makes it faster.\n\n' +
        'Run with --dry-run to list what would be baked.\n',
    );
    return 1;
  }

  if (dryRun) {
    stdout.write(`${phrases.length} bakeable phrase(s):\n\n`);
    for (const p of phrases) stdout.write(`  ${p.id.padEnd(34)} ${p.text}\n`);
    return 0;
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const clips: Record<string, ClipRecord> = {};
  let total = 0;
  let failures = 0;

  for (const phrase of phrases) {
    const file = `${phrase.id}.opus`;
    try {
      const audio = await synthesise(phrase.text, apiKey);
      const bytes = audio.byteLength;
      writeFileSync(join(OUT_DIR, file), Buffer.from(audio));
      clips[phrase.id] = { file, hash: hashOf(phrase.text), bytes, text: phrase.text };
      total += bytes;
      stdout.write(`  baked  ${phrase.id.padEnd(34)} ${(bytes / 1024).toFixed(1)} KB\n`);
    } catch (error: unknown) {
      failures += 1;
      stdout.write(`  FAILED ${phrase.id.padEnd(34)} ${error instanceof Error ? error.message : String(error)}\n`);
    }
    // The free tier is rate-limited and this runs once. Being polite here costs
    // a few seconds and avoids a 429 halfway through.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    provider: 'groq',
    model: PROVIDER.model,
    voice: PROVIDER.voice,
    clips,
  };
  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const budget = 300 * 1024;
  stdout.write(`\n${Object.keys(clips).length}/${phrases.length} baked, ${(total / 1024).toFixed(1)} KB total`);
  stdout.write(` (budget ${(budget / 1024).toFixed(0)} KB)\n`);

  if (total > budget) {
    stdout.write('\nOver the 300 KB budget from plan §15. Lower the bitrate or bake fewer variants.\n');
    return 1;
  }
  if (failures > 0) {
    stdout.write(`\n${failures} phrase(s) failed. Re-run to retry; existing clips are reused.\n`);
    return 1;
  }

  stdout.write('\nDone. Commit public/audio/ and the site will serve these instead of synthesising.\n');
  return 0;
}

main()
  .then((code) => exit(code))
  .catch((error: unknown) => {
    stdout.write(`bake-audio failed: ${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  });
