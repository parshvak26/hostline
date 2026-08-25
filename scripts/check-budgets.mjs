#!/usr/bin/env node
/**
 * Performance budgets (plan §15), enforced rather than hoped for.
 *
 * A budget that is checked only when someone remembers is not a budget. These
 * numbers come straight from the plan's performance table and the build fails
 * when one is crossed — which is the only reason the README is allowed to
 * mention them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const BUDGETS = {
  js: { limit: 120 * 1024, label: 'JavaScript (gzipped)' },
  css: { limit: 20 * 1024, label: 'CSS (gzipped)' },
  fonts: { limit: 60 * 1024, label: 'Fonts (raw)' },
  audio: { limit: 300 * 1024, label: 'Prebaked audio (raw)' },
};

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const dist = join(ROOT, 'dist');
const files = walk(dist);

if (files.length === 0) {
  console.error('No build output in dist/. Run `npm run build` first.');
  process.exit(1);
}

const gzipped = (file) => gzipSync(readFileSync(file)).length;
const raw = (file) => statSync(file).size;

const totals = {
  js: files.filter((f) => f.endsWith('.js')).reduce((sum, f) => sum + gzipped(f), 0),
  css: files.filter((f) => f.endsWith('.css')).reduce((sum, f) => sum + gzipped(f), 0),
  fonts: files.filter((f) => /\.(woff2?|ttf|otf)$/.test(f)).reduce((sum, f) => sum + raw(f), 0),
  audio: files.filter((f) => /\.(opus|ogg|mp3|m4a)$/.test(f)).reduce((sum, f) => sum + raw(f), 0),
};

// Sourcemaps ship for debuggability but are not fetched unless devtools is
// open, so they do not count against the transfer budget.
const transfer = files
  .filter((f) => !f.endsWith('.map'))
  .reduce((sum, f) => sum + gzipped(f), 0);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
let failed = false;

for (const [key, { limit, label }] of Object.entries(BUDGETS)) {
  const value = totals[key];
  const ok = value <= limit;
  if (!ok) failed = true;
  const state = ok ? 'ok  ' : 'OVER';
  console.log(`${state} ${label.padEnd(24)} ${kb(value).padStart(10)} / ${kb(limit)}`);
}

console.log(`     ${'Total first visit (gz)'.padEnd(24)} ${kb(transfer).padStart(10)} / ${kb(2 * 1024 * 1024)}`);
if (transfer > 2 * 1024 * 1024) {
  failed = true;
  console.error('Total first-visit transfer is over the 2MB budget.');
}

if (failed) {
  console.error('\nBudget exceeded. Plan §15 sets these; raising one is a decision, not a fix.');
  process.exit(1);
}
console.log('\nAll budgets met.');
