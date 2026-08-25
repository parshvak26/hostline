import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import globals from 'globals';

/**
 * Engine purity (R-43, T-003).
 *
 * `src/engine/` is the only part of this project whose correctness is
 * load-bearing, so it is kept pure by tooling rather than by convention:
 * no DOM, no network, no storage, and — the one people forget — no ambient
 * clock. Time is injected through `deps.clock`, which is what makes the
 * availability tests able to assert exact boundaries.
 */
const ENGINE_FORBIDDEN_GLOBALS = [
  { name: 'window', message: 'src/engine must not touch the DOM. Take what you need as an argument.' },
  { name: 'document', message: 'src/engine must not touch the DOM.' },
  { name: 'navigator', message: 'src/engine must not touch browser APIs.' },
  { name: 'fetch', message: 'src/engine must not do I/O. The orchestrator owns the network.' },
  { name: 'XMLHttpRequest', message: 'src/engine must not do I/O.' },
  { name: 'WebSocket', message: 'src/engine must not do I/O.' },
  { name: 'localStorage', message: 'src/engine must not touch storage. Use the repository port.' },
  { name: 'sessionStorage', message: 'src/engine must not touch storage.' },
  { name: 'indexedDB', message: 'src/engine must not touch storage.' },
  { name: 'crypto', message: 'src/engine must be deterministic. Randomness is injected via deps.' },
  { name: 'performance', message: 'src/engine must not read a clock. Use deps.clock.' },
  { name: 'setTimeout', message: 'src/engine must not schedule work. Return an Effect instead.' },
  { name: 'setInterval', message: 'src/engine must not schedule work. Return an Effect instead.' },
  { name: 'process', message: 'src/engine must not read the environment.' },
  { name: 'console', message: 'src/engine must not log. Return an Effect instead.' },
];

const NO_HTML_SINKS = [
  {
    selector: "MemberExpression[property.name='innerHTML']",
    message: 'innerHTML is banned (plan §13). Use textContent, or build nodes explicitly.',
  },
  {
    selector: "MemberExpression[property.name='outerHTML']",
    message: 'outerHTML is banned (plan §13). Build nodes explicitly.',
  },
  {
    selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
    message: 'insertAdjacentHTML is banned (plan §13). Build nodes explicitly.',
  },
  {
    selector: "CallExpression[callee.object.name='document'][callee.property.name='write']",
    message: 'document.write is banned.',
  },
];

export default [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'worker/node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'tools/eslint-rules/fixtures/**',
      'public/**',
    ],
  },
  js.configs.recommended,

  // ---- Everything TypeScript --------------------------------------------
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-restricted-syntax': ['error', ...NO_HTML_SINKS],
      // `no-undef` cannot see TypeScript's own lib types — it reports
      // `HTMLElementTagNameMap` and `RequestInit` as undefined globals. tsc
      // checks the same thing correctly, so this is off for TypeScript by the
      // typescript-eslint project's own recommendation.
      'no-undef': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // ---- The engine: pure, or it is not the engine -------------------------
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...ENGINE_FORBIDDEN_GLOBALS],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'src/engine must not read a clock. Use deps.clock.now().' },
        { object: 'Math', property: 'random', message: 'src/engine must be deterministic. Randomness is injected via deps.' },
      ],
      'no-restricted-syntax': [
        'error',
        ...NO_HTML_SINKS,
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'src/engine must not construct a Date from the ambient clock. Use deps.clock and the pure date helpers in src/engine/time.ts.',
        },
        {
          selector: "CallExpression[callee.object.name='Date']",
          message: 'src/engine must not read the ambient clock. Use deps.clock.now().',
        },
        {
          selector: "ImportDeclaration[source.value!=/^\\.\\/[^/]+$/]",
          message:
            'src/engine imports only from src/engine. No packages, no sibling directories, no exceptions — that constraint is the reason this directory can be tested exhaustively.',
        },
        {
          selector: "ExportNamedDeclaration[source.value!=/^\\.\\/[^/]+$/][source]",
          message: 'src/engine re-exports only from src/engine.',
        },
        {
          selector: "ExportAllDeclaration[source.value!=/^\\.\\/[^/]+$/]",
          message: 'src/engine re-exports only from src/engine.',
        },
      ],
      // `src/engine` may import from `src/engine` and from nothing else. Not a
      // package, not a sibling directory, not a type-only helper "just this
      // once". Expressed as a syntax rule rather than an import pattern because
      // the pattern matchers cannot say "only same-directory relative" cleanly.
      'no-restricted-imports': 'off',
    },
  },

  // ---- Scripts and tests: allowed to be impure ---------------------------
  {
    files: ['scripts/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts', '*.config.ts', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // ---- The gateway worker ------------------------------------------------
  // Cloudflare's runtime globals are neither browser nor Node. Declaring them
  // here rather than adding `/* global */` comments to every file keeps the
  // worker's source looking like ordinary TypeScript.
  {
    files: ['worker/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        ExecutionContext: 'readonly',
        KVNamespace: 'readonly',
        DurableObjectNamespace: 'readonly',
        R2Bucket: 'readonly',
        Fetcher: 'readonly',
        ScheduledEvent: 'readonly',
        ExportedHandler: 'readonly',
        IncomingRequestCfProperties: 'readonly',
        console: 'readonly',
      },
    },
  },

  // ---- The single audited innerHTML exception ----------------------------
  // The "How this works" diagram is a hand-authored, checked-in SVG string with
  // no interpolation of any kind. It is the only place HTML is injected, and it
  // is reviewed as an asset rather than as code.
  {
    files: ['src/ui/views/how-it-works.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
];
