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
 * latency budget, and it also cuts runtime provider calls by roughly half.
 *
 * Only lines with no placeholders can be baked — the read-back contains the
 * visitor's own name and will always be synthesised live. `bakeablePhrases()`
 * decides; there is no separate list to keep in step.
 *
 * ## Two things the provider forces on us
 *
 * **It is rate limited to ten requests a minute**, so this is paced rather than
 * fast. Thirty-four lines take about four minutes. It is also *resumable*: a
 * clip whose text has not changed is never re-fetched, so an interrupted run
 * costs nothing to repeat.
 *
 * **It only returns WAV.** Uncompressed audio would be roughly 4MB for the set,
 * against a 300KB budget — so each clip is transcoded to Opus locally with
 * ffmpeg. Without ffmpeg the raw format is kept and the budget check says so
 * rather than silently shipping four megabytes.
 *
 * ## Running it
 *
 *   export GROQ_API_KEY=...          # never committed, never in the bundle
 *   npm run bake-audio
 *
 * The key is read from the environment and used only here, on the operator's
 * own machine. It never reaches the browser and never reaches the repository.
 *
 * Until this has been run, the site is fully functional — the browser's own
 * voice speaks every line. The cache is a speed feature, not a dependency.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, env, exit, stdout } from 'node:process';

import { bakeablePhrases } from '../src/config/phrases.js';

const OUT_DIR = new URL('../public/audio/', import.meta.url).pathname;

/**
 * Provider settings.
 *
 * Groq is the plan's choice (§0), behind one constant so that swapping provider
 * is a two-line change here and a two-line change in
 * `worker/src/providers/tts.ts`. If the free tier has moved, plan §0's fallback
 * order is Cloudflare Workers AI, then Gemini TTS.
 *
 * **Verified 2026-08-26.** Groq decommissioned `playai-tts` on 2025-12-31 and
 * replaced it with Canopy Labs' Orpheus, which requires a one-time terms
 * acceptance in the console before it will answer at all. See ADR-0006.
 */
const PROVIDER = {
  url: 'https://api.groq.com/openai/v1/audio/speech',
  model: env['HOSTLINE_TTS_MODEL'] ?? 'canopylabs/orpheus-v1-english',
  voice: env['HOSTLINE_TTS_VOICE'] ?? 'troy',
} as const;

/** Formats to ask for, best first. Opus is preferred; WAV is the fallback. */
const FORMATS = ['opus', 'mp3', 'wav'] as const;
type Format = (typeof FORMATS)[number];

/**
 * Ten requests per minute on the free tier, so one every six and a bit seconds.
 * Deliberately a little slower than the limit — sitting exactly on it turns
 * every clock skew into a 429 and a retry, which is slower than going slower.
 */
const REQUEST_SPACING_MS = 6_500;
const MAX_RETRIES = 4;

/** Opus at 24kbps mono. Speech, not music; transparent enough for it. */
const OPUS_BITRATE = '24k';

const BUDGET_BYTES = 300 * 1024;

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
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

/* -------------------------------------------------------------- provider -- */

class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

/** "Please try again in 6s" / "in 1m2.5s" → milliseconds. */
function parseRetryAfter(body: string): number | null {
  const compound = /try again in (\d+)m([\d.]+)s/i.exec(body);
  if (compound?.[1] !== undefined && compound[2] !== undefined) {
    return Math.ceil((Number(compound[1]) * 60 + Number(compound[2])) * 1000);
  }
  const seconds = /try again in ([\d.]+)s/i.exec(body);
  if (seconds?.[1] !== undefined) return Math.ceil(Number(seconds[1]) * 1000);
  return null;
}

async function synthesise(text: string, apiKey: string, format: Format): Promise<Buffer> {
  const response = await fetch(PROVIDER.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: PROVIDER.model, voice: PROVIDER.voice, input: text, response_format: format }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ProviderError(
      `${response.status} ${response.statusText}${detail === '' ? '' : ` — ${detail.slice(0, 240)}`}`,
      response.status,
      parseRetryAfter(detail),
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Synthesise, waiting out a rate limit rather than treating it as a failure.
 *
 * A 429 is the provider telling us exactly how long to wait. Ignoring that and
 * reporting two dozen failures — which is what the first version of this script
 * did — turns a slow job into a broken one.
 */
async function synthesiseWithRetry(text: string, apiKey: string, format: Format): Promise<Buffer> {
  let attempt = 0;
  for (;;) {
    try {
      return await synthesise(text, apiKey, format);
    } catch (error: unknown) {
      const rateLimited = error instanceof ProviderError && error.status === 429;
      if (!rateLimited || attempt >= MAX_RETRIES) throw error;

      attempt += 1;
      const wait = (error.retryAfterMs ?? REQUEST_SPACING_MS) + 1_000;
      stdout.write(`  waiting ${(wait / 1000).toFixed(0)}s for the rate limit…\n`);
      await sleep(wait);
    }
  }
}

async function negotiateFormat(apiKey: string): Promise<Format | { error: string }> {
  let lastError = 'unknown';
  for (const format of FORMATS) {
    try {
      await synthesise('One moment.', apiKey, format);
      return format;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
      // A terms refusal is not a format problem, and a rate limit means the
      // format was accepted. Neither is a reason to try the next one.
      if (lastError.includes('model_terms_required')) return { error: lastError };
      if (error instanceof ProviderError && error.status === 429) return format;
    }
  }
  return { error: lastError };
}

/* ---------------------------------------------------------------- ffmpeg -- */

async function hasFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const probe = spawn('ffmpeg', ['-version']);
      probe.on('error', () => resolve(false));
      probe.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/**
 * WAV in, Opus out, entirely in memory.
 *
 * `-application voip` tunes the encoder for speech rather than music, which is
 * what makes 24kbps sound fine instead of watery.
 */
function toOpus(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-c:a',
      'libopus',
      '-b:a',
      OPUS_BITRATE,
      '-ac',
      '1',
      '-application',
      'voip',
      '-f',
      'opus',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errors).toString().slice(0, 200)}`));
    });

    ffmpeg.stdin.on('error', reject);
    ffmpeg.stdin.end(input);
  });
}

/* ------------------------------------------------------------------ main -- */

function loadManifest(): Manifest | null {
  const path = join(OUT_DIR, 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

/** Remove leftovers from an earlier run in a different format. */
function tidy(keep: ReadonlySet<string>): void {
  for (const name of readdirSync(OUT_DIR)) {
    if (keep.has(name)) continue;
    if (/\.(opus|wav|mp3|ogg)$/.test(name)) unlinkSync(join(OUT_DIR, name));
  }
}

async function main(): Promise<number> {
  const apiKey = env['GROQ_API_KEY'] ?? env['TTS_API_KEY'] ?? '';
  const dryRun = argv.includes('--dry-run');
  const phrases = bakeablePhrases();

  if (dryRun) {
    stdout.write(`${phrases.length} bakeable phrase(s):\n\n`);
    for (const phrase of phrases) stdout.write(`  ${phrase.id.padEnd(34)} ${phrase.text}\n`);
    return 0;
  }

  if (apiKey === '') {
    stdout.write(
      'No GROQ_API_KEY (or TTS_API_KEY) in the environment.\n\n' +
        `${phrases.length} phrase(s) are ready to bake. Set the key and run again:\n\n` +
        '  export GROQ_API_KEY=your-key-here\n' +
        '  npm run bake-audio\n\n' +
        "The site works without this. Every line is spoken by the browser's own\n" +
        'voice until the cache exists; baking only makes it faster.\n',
    );
    return 1;
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const negotiated = await negotiateFormat(apiKey);
  if (typeof negotiated !== 'string') {
    if (negotiated.error.includes('model_terms_required')) {
      stdout.write(
        `\nThis model needs its terms accepted once before it will answer.\n\n` +
          `  Open: https://console.groq.com/playground?model=${encodeURIComponent(PROVIDER.model)}\n` +
          `  Accept the terms, then run this again.\n\n` +
          `Nothing else is wrong — the key works and the model exists.\n`,
      );
      return 1;
    }
    stdout.write(`\nCould not synthesise anything.\n\n  ${negotiated.error}\n`);
    return 1;
  }

  const sourceFormat: Format = negotiated;
  const ffmpeg = await hasFfmpeg();
  const transcode = sourceFormat !== 'opus' && ffmpeg;
  const storedFormat: Format = transcode ? 'opus' : sourceFormat;

  if (sourceFormat !== 'opus') {
    stdout.write(
      transcode
        ? `The provider only returns ${sourceFormat}; transcoding each clip to opus locally.\n`
        : `The provider only returns ${sourceFormat}, and ffmpeg is not installed, so clips stay ${sourceFormat}.\n` +
            `Install ffmpeg (brew install ffmpeg) to get them inside the size budget.\n`,
    );
  }
  stdout.write(`Pacing at one request every ${REQUEST_SPACING_MS / 1000}s — the free tier allows ten a minute.\n\n`);

  const previous = loadManifest();
  const clips: Record<string, ClipRecord> = {};
  let failures = 0;
  let fetched = 0;

  for (const phrase of phrases) {
    const file = `${phrase.id}.${storedFormat}`;
    const path = join(OUT_DIR, file);
    const hash = hashOf(phrase.text);

    // Resumable. A rate limit makes interrupted runs likely, and repeating one
    // must not cost the whole job again.
    const already = previous?.clips[phrase.id];
    if (already !== undefined && already.hash === hash && already.file === file && existsSync(path)) {
      clips[phrase.id] = already;
      stdout.write(`  kept   ${phrase.id.padEnd(34)} ${kb(already.bytes)}\n`);
      continue;
    }

    try {
      // A clip left by an earlier run in the source format is worth transcoding
      // rather than re-fetching: no request, no rate-limit wait.
      const stale = join(OUT_DIR, `${phrase.id}.${sourceFormat}`);
      let audio: Buffer;

      if (transcode && existsSync(stale)) {
        audio = await toOpus(readFileSync(stale));
        unlinkSync(stale);
      } else {
        if (fetched > 0) await sleep(REQUEST_SPACING_MS);
        audio = await synthesiseWithRetry(phrase.text, apiKey, sourceFormat);
        fetched += 1;
        if (transcode) audio = await toOpus(audio);
      }

      writeFileSync(path, audio);
      clips[phrase.id] = { file, hash, bytes: audio.byteLength, text: phrase.text };
      stdout.write(`  baked  ${phrase.id.padEnd(34)} ${kb(audio.byteLength)}\n`);
    } catch (error: unknown) {
      failures += 1;
      stdout.write(`  FAILED ${phrase.id.padEnd(34)} ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  tidy(new Set(Object.values(clips).map((clip) => clip.file)));

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    provider: 'groq',
    model: PROVIDER.model,
    voice: PROVIDER.voice,
    clips,
  };
  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const total = Object.values(clips).reduce((sum, clip) => sum + clip.bytes, 0);
  stdout.write(`\n${Object.keys(clips).length}/${phrases.length} baked, ${kb(total)} total`);
  stdout.write(` (budget ${BUDGET_BYTES / 1024} KB)\n`);

  if (failures > 0) {
    stdout.write(`\n${failures} phrase(s) failed. Run it again — everything already baked is kept.\n`);
    return 1;
  }
  if (total > BUDGET_BYTES) {
    stdout.write(
      `\nOver the budget from plan §15.` +
        (storedFormat === 'opus'
          ? ' Lower the bitrate or bake fewer variants.\n'
          : `\nInstall ffmpeg and run again to compress these, or drop the cache —\n` +
            `the browser voice covers every line without it.\n`),
    );
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
