# ADR-0005 — Two files added to the planned layout: `engine/time.ts` and `agent/session.ts`

**Date:** 2026-08-25
**Status:** Accepted
**Deviates from:** plan §9 (repository structure)

## Context

Plan §9 lists the engine as `types · machine · validate · availability ·
prompts · confirm · index`, and the agent layer as `orchestrator · ports ·
brains/`. Two files were added during Phase 1. Both are recorded here rather
than left as silent drift.

## `src/engine/time.ts`

R-43 forbids the engine from reading a clock, and the lint rule bans `Date`
outright inside `src/engine/`. But the booking domain is full of calendar
arithmetic: what weekday is this, how many days until then, does the 31st exist
in this month, do these two intervals overlap.

That arithmetic had to live somewhere pure. Spreading it across `availability.ts`
and `validate.ts` would have duplicated the awkward parts — day-number
conversion and month lengths — in the two files where an off-by-one is most
expensive. It is one file of integer arithmetic on `YYYY-MM-DD` and `HH:MM`
strings, with no timezone knowledge at all; converting a real instant into those
strings happens once, outside the engine, in `src/agent/clock.ts`.

## `src/agent/session.ts`

Plan §9 gives the agent layer one orchestrator. In practice the turn loop has
two separable halves: deciding what happens in a turn, and coordinating audio,
timers and barge-in while it happens.

`session.ts` is the first half — a headless `Conversation` that takes text in and
returns the lines the agent must say. It has no timers and no audio, so the
terminal runner (`scripts/converse.ts`), the fixture harness and the latency
replay all drive the real conversation logic rather than a reimplementation of
it. `orchestrator.ts` is the second half and wraps it.

Splitting them is what makes a fixture conversation meaningful: a conversation
that passes in the harness passes in the browser, because it is the same code
deciding.

## Consequences

- The engine's public surface (`src/engine/index.ts`) re-exports the time
  helpers, so callers outside the engine still import from one place.
- The ESLint purity rule covers `time.ts` like every other engine file.
- `session.ts` is where the "engine's line wins over the model's wording" rule is
  enforced, which is worth knowing when reading the boundary.
