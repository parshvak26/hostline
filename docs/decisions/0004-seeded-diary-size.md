# ADR-0004 — The seeded diary holds twelve bookings, not four to six

**Date:** 2026-08-25
**Status:** Accepted
**Deviates from:** plan §10.6 ("4–6 plausible bookings")
**Requirement:** T-034

## Context

Plan §10.6 asks for 4–6 seeded bookings positioned so that 19:00 on the next
Friday is deliberately full — the designed demo moment, where a reviewer asks
for the most obvious slot and sees the engine refuse and offer real
alternatives.

Four to six bookings cannot make that true, and the reason is best-fit
allocation. A party of four fits a four-top **or** a six-top. The room has five
four-tops and two six-tops. Filling only the four-tops leaves both six-tops free
and the request succeeds; the demo moment does not happen.

Making it happen honestly requires all seven of those tables occupied across the
requested interval. There is no way to reach five or six that does not involve
special-casing the engine, and special-casing the engine is the one thing this
project must not do — the whole claim is that availability is computed, not
arranged.

## Decision

Twelve seeded bookings: seven that genuinely block 19:00 on the next Friday for
a party of four, two two-tops on the same evening so the diary reads like a real
service, and three on the preceding Thursday so "tonight" is never an empty
screen.

The blocking bookings sit at 18:30–19:00. Friday dinner opens at 18:30 and a
party of four holds a table for 105 minutes, so those bookings run to 20:15 at
the earliest — which leaves 20:15, 20:30 and 20:45 free and produces **exactly
three alternatives** inside the engine's ±120-minute search. That is T-034's
acceptance criterion, and `tests/unit/seed.test.ts` asserts it.

## Consequences

- A party of **two** at Friday 19:00 still succeeds, because the two-tops are
  free. This is correct rather than convenient: the room really does have space,
  just not for four people. A reviewer who tries both sees a system that is
  counting rather than performing.
- The seed is computed relative to the injected clock, never a hard-coded date,
  so the demo moment still works in two years without anyone touching it.
- Moving the seeded times changes the number of alternatives. The test is what
  will say so.
