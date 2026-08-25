/**
 * Proof that the lint rules actually fire (T-003).
 *
 * The engine-purity rule is load-bearing: plan §26 talking point 4 says purity
 * is *enforced by tooling, not convention*, and R-43 makes it an acceptance
 * criterion. A rule nobody has watched fail is a rule nobody should believe in,
 * so these tests feed deliberate violations through ESLint and assert that each
 * one is caught by name.
 *
 * If someone loosens `eslint.config.js`, this goes red before the engine
 * quietly starts reading `Date.now()`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const fixture = (name: string) => readFileSync(resolve(root, 'tools/eslint-rules/fixtures', name), 'utf8');

const eslint = new ESLint({ cwd: root });

async function ruleIdsFor(code: string, filePath: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath: resolve(root, filePath), warnIgnored: false });
  return results.flatMap((r) => r.messages.map((m) => m.ruleId ?? 'fatal'));
}

async function messagesFor(code: string, filePath: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath: resolve(root, filePath), warnIgnored: false });
  return results.flatMap((r) => r.messages.map((m) => m.message));
}

describe('engine purity rule', () => {
  const impure = fixture('engine-impurity.ts.fixture');

  it('rejects every impurity in the fixture when the file lives in src/engine', async () => {
    const messages = await messagesFor(impure, 'src/engine/__probe.ts');
    const joined = messages.join('\n');

    expect(joined).toContain('imports only from src/engine');
    expect(joined).toContain('must not read the ambient clock');
    expect(joined).toContain('must not touch the DOM');
    expect(joined).toContain('must not do I/O');
    expect(joined).toContain('must not touch storage');
    expect(joined).toContain('must be deterministic');
  });

  it('does not apply the purity rules outside src/engine', async () => {
    // The same code in the agent layer is allowed to be impure — that layer is
    // where I/O belongs. Only the innerHTML ban survives outside the engine.
    const ids = await ruleIdsFor(impure, 'src/agent/__probe.ts');
    expect(ids).not.toContain('no-restricted-globals');
    expect(ids).not.toContain('no-restricted-properties');
  });

  it('accepts a same-directory relative import inside the engine', async () => {
    const clean = `import type { IsoDate } from './types.js';\nexport const passthrough = (d: IsoDate): IsoDate => d;\n`;
    const ids = await ruleIdsFor(clean, 'src/engine/__probe.ts');
    expect(ids).toEqual([]);
  });

  it('rejects a subdirectory import inside the engine', async () => {
    const nested = `import { x } from './nested/thing.js';\nexport const y = x;\n`;
    const messages = await messagesFor(nested, 'src/engine/__probe.ts');
    expect(messages.join('\n')).toContain('imports only from src/engine');
  });
});

describe('innerHTML ban', () => {
  const html = fixture('innerhtml.ts.fixture');

  it('fires anywhere in the project', async () => {
    const messages = await messagesFor(html, 'src/ui/components/__probe.ts');
    const joined = messages.join('\n');
    expect(joined).toContain('innerHTML is banned');
    expect(joined).toContain('insertAdjacentHTML is banned');
  });

  it('is lifted only for the hand-authored diagram', async () => {
    // The single audited exception (plan §13). If this test starts failing it
    // means the allowlist moved, which is exactly when someone should look.
    const ids = await ruleIdsFor(html, 'src/ui/views/how-it-works.ts');
    expect(ids).not.toContain('no-restricted-syntax');
  });
});
