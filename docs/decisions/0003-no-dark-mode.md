# ADR-0003 — One light palette; no dark mode for MVP

**Date:** 2026-08-25
**Status:** Accepted
**Requirement:** plan §5.2

## Context

Dark mode is close to an expectation for developer-facing pages, and a hiring
manager opening this link may well have their system set to dark.

But the visual goal is specific: a page that looks like a small restaurant made
it. That look is cream paper, dark ink, one warm terracotta accent, and a lot of
whitespace. A second palette is not a colour swap — the warm neutrals that carry
the whole design have no natural dark counterpart, and every contrast pair,
every hairline and the listening indicator would need re-deciding.

## Decision

One committed warm light palette. No dark mode in the MVP.

Recorded as a deliberate choice rather than an omission, because the difference
matters to a reviewer.

## Consequences

- `tokens.css` defines the palette once and is the only file permitted a raw hex
  value; a CI grep enforces that.
- Contrast is chosen to pass WCAG AA rather than approximated, and is checked by
  axe-core in CI.
- Adding dark mode later is a token-block change plus a contrast pass. Nothing
  else in the stylesheet hard-codes a colour, so the work is bounded.
- The honest cost: on a dark-set machine the page is a bright rectangle. That is
  a real downside and the README's limitations section says so.
