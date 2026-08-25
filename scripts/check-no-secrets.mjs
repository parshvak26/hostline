#!/usr/bin/env node
/**
 * Fail the deploy if anything key-shaped reached the browser bundle (R-30).
 *
 * `gitleaks` covers the repository's history. This covers the other direction:
 * a build that inlines a key from the environment, which history scanning would
 * never see. The bundle is allowed exactly two public values — the gateway URL
 * and the Turnstile *site* key — and nothing else that looks like a credential.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');

/** Provider key shapes, plus the generic high-entropy assignment. */
const PATTERNS = [
  { name: 'Groq key', re: /gsk_[A-Za-z0-9]{20,}/ },
  { name: 'OpenAI key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9-]{20,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: 'Cloudflare token', re: /\b[A-Za-z0-9_-]{40}\b(?=[^A-Za-z0-9_-]*cloudflare)/i },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Turnstile SECRET key', re: /0x[A-Za-z0-9]{30,}/ },
  { name: 'Bearer literal', re: /Bearer\s+[A-Za-z0-9._-]{30,}/ },
  { name: 'named secret assignment', re: /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9._-]{24,}["']/i },
];

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
    else if (/\.(js|css|html|json|map)$/.test(full)) out.push(full);
  }
  return out;
}

const files = walk(DIST);
if (files.length === 0) {
  console.error('No build output in dist/. Run `npm run build` first.');
  process.exit(1);
}

const findings = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const { name, re } of PATTERNS) {
    const match = re.exec(text);
    if (match) {
      findings.push(`${relative(ROOT, file)}: possible ${name} — ${match[0].slice(0, 12)}…`);
    }
  }
}

if (findings.length > 0) {
  console.error('\nSecret-shaped values found in the browser bundle:\n');
  for (const f of findings) console.error(`  ${f}`);
  console.error('\nThe bundle may contain only the public gateway URL and the public Turnstile site key.');
  process.exit(1);
}

console.log(`No secret-shaped values in ${files.length} built file(s).`);
