#!/usr/bin/env node
/**
 * Plan §5.2 is binding, so it is enforced rather than remembered.
 *
 * Two checks, both greps, both cheap enough to run on every push:
 *   1. Forbidden visual patterns — gradients, glow, blur, oversized radii.
 *      These are the fingerprints of a generated page, which R-50 forbids.
 *   2. No raw hex outside the token file (T-007). One palette, defined once.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const STYLE_DIR = join(ROOT, 'src/ui/styles');
const TOKEN_FILE = join(STYLE_DIR, 'tokens.css');

/** Radii above 4px are allowed only on these selectors (plan §5.2). */
const RADIUS_ALLOWLIST = ['.talk-button', '.avatar', '.listening-indicator__dot', '.mode-tag'];

const FORBIDDEN = [
  { name: 'gradient', re: /\b(linear|radial|conic)-gradient\s*\(/i },
  { name: 'backdrop-filter / blur', re: /backdrop-filter|(?<!drop-shadow\()\bblur\s*\(/i },
  { name: 'coloured box-shadow (glow)', re: /box-shadow\s*:[^;]*(rgba?\(|hsla?\(|#[0-9a-f]{3,8})/i },
  { name: 'text-shadow', re: /text-shadow\s*:(?!\s*none)/i },
  { name: 'filter: drop-shadow', re: /filter\s*:[^;]*drop-shadow/i },
];

function cssFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...cssFiles(full));
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

const problems = [];
let files;
try {
  files = cssFiles(STYLE_DIR);
} catch {
  console.error(`No stylesheets found at ${STYLE_DIR}`);
  process.exit(1);
}

for (const file of files) {
  const rel = relative(ROOT, file);
  const lines = readFileSync(file, 'utf8').split('\n');
  let currentSelector = '';

  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    const trimmed = line.trim();

    if (trimmed.endsWith('{')) currentSelector = trimmed.slice(0, -1).trim();

    // Comments are allowed to name the thing they are forbidding.
    const code = line.replace(/\/\*.*?\*\//g, '').split('/*')[0];
    if (!code.trim()) return;

    for (const { name, re } of FORBIDDEN) {
      if (re.test(code)) problems.push(`${at}  forbidden: ${name}\n    ${trimmed}`);
    }

    // border-radius above 4px, outside the allowlist.
    const radius = code.match(/border-radius\s*:\s*([^;]+)/i);
    if (radius) {
      const allowed = RADIUS_ALLOWLIST.some((sel) => currentSelector.includes(sel));
      const values = radius[1].match(/(\d+(?:\.\d+)?)px/g) ?? [];
      const tooBig = values.some((v) => parseFloat(v) > 4);
      const isPill = /9999px|50%/.test(radius[1]);
      if ((tooBig || isPill) && !allowed) {
        problems.push(
          `${at}  border-radius >4px outside the allowlist (selector: ${currentSelector || '?'})\n    ${trimmed}`,
        );
      }
    }

    // Raw hex outside tokens.css (T-007).
    if (file !== TOKEN_FILE && /#[0-9a-fA-F]{3,8}\b/.test(code)) {
      problems.push(`${at}  raw hex colour outside tokens.css — use a custom property\n    ${trimmed}`);
    }
  });
}

if (problems.length) {
  console.error(`\nDesign rule violations (plan §5.2):\n\n${problems.join('\n')}\n`);
  console.error(`${problems.length} violation(s). These rules are binding, not advisory.\n`);
  process.exit(1);
}

console.log(`Design rules clean across ${files.length} stylesheet(s).`);
