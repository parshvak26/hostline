/**
 * Tell TypeScript what `env` from `cloudflare:test` actually holds.
 *
 * `@cloudflare/vitest-pool-workers` exports it as an empty `ProvidedEnv` that
 * each project is expected to widen. Without this the worker tests run
 * perfectly — Vitest does not typecheck — while `tsc --noEmit` fails on every
 * binding, which is exactly the kind of split that lets type errors accumulate
 * unnoticed in a test suite.
 *
 * The bindings themselves are set in `worker/vitest.config.ts` under
 * `miniflare.bindings` and `miniflare.kvNamespaces`.
 */

import type { Env } from '../src/types.js';

declare module 'cloudflare:test' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}
