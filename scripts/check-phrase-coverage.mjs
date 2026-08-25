#!/usr/bin/env node
/**
 * Every phrase that can be baked has a baked file, and every baked file still
 * matches its phrase (T-081).
 *
 * Plan §19 names the failure mode this prevents: prebaked audio drifting out of
 * sync with the copy, so the agent's voice says one thing while the transcript
 * says another. The manifest stores a content hash of the text, so a reworded
 * line invalidates its clip rather than silently keeping the old one.
 *
 * Until `scripts/bake-audio.ts` has been run — it needs a provider key — this
 * reports what is missing and exits 0, because an unbaked cache is a
 * performance shortfall, not a broken build. Pass `--strict` in CI once the
 * audio has been committed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;
const AUDIO_DIR = join(ROOT, 'public/audio');
const MANIFEST = join(AUDIO_DIR, 'manifest.json');
const strict = process.argv.includes('--strict');

const { bakeablePhrases } = await import(pathToFileURL(join(ROOT, 'src/config/phrases.ts')).href).catch(
  async () => {
    // phrases.ts is TypeScript; run through tsx when imported directly.
    const { execFileSync } = await import('node:child_process');
    const json = execFileSync(
      'npx',
      ['tsx', '-e', "import {bakeablePhrases} from './src/config/phrases.ts'; console.log(JSON.stringify(bakeablePhrases()));"],
      { cwd: ROOT, encoding: 'utf8' },
    );
    const parsed = JSON.parse(json.trim().split('\n').pop());
    return { bakeablePhrases: () => parsed };
  },
);

const phrases = bakeablePhrases();
const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

if (!existsSync(MANIFEST)) {
  const message =
    `No baked audio manifest at public/audio/manifest.json.\n` +
    `${phrases.length} phrase(s) are bakeable and none are baked.\n` +
    `Run \`npm run bake-audio\` once a provider key is configured (see RUNBOOK.md).`;
  if (strict) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  console.warn('\nNot a failure: the browser voice covers every line until the cache exists.');
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const problems = [];

for (const phrase of phrases) {
  const record = manifest.clips?.[phrase.id];
  if (record === undefined) {
    problems.push(`${phrase.id}: no baked clip`);
    continue;
  }
  if (record.hash !== hash(phrase.text)) {
    problems.push(`${phrase.id}: the wording changed since it was baked — re-run bake-audio`);
  }
  if (!existsSync(join(AUDIO_DIR, record.file))) {
    problems.push(`${phrase.id}: manifest points at ${record.file}, which is missing`);
  }
}

for (const id of Object.keys(manifest.clips ?? {})) {
  if (!phrases.some((p) => p.id === id)) problems.push(`${id}: baked but no longer in phrases.ts`);
}

if (problems.length > 0) {
  console.error(`\nPrebaked audio is out of sync with src/config/phrases.ts:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(strict ? 1 : 0);
}

console.log(`All ${phrases.length} bakeable phrase(s) have a matching baked clip.`);
