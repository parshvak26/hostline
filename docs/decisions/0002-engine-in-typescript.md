# ADR-0002 — The booking engine is TypeScript, not Python

**Date:** 2026-08-25
**Status:** Accepted
**Supersedes:** the v1/v2 plan for a shared Python engine
**Requirement:** goal §14, assumption A3

## Context

Earlier revisions put the booking engine in Python so it could be shared between
a browser build (via Pyodide) and a telephony server. Revision 3 of the goal
dropped telephony entirely: no phone number, browser only.

With the phone server gone, the Python engine's only remaining job was to run in
the browser, where it cost roughly 7MB of runtime download for no shared
consumer — against a total first-visit budget of 2MB.

## Decision

The engine is written in TypeScript, in the same language as the rest of the
site, with zero dependencies.

## Consequences

- First-visit transfer stays inside the 2MB budget with room to spare.
- The engine keeps the property that mattered about the Python plan: it is pure,
  self-contained logic with no I/O. An ESLint rule enforces that it imports
  nothing outside `src/engine/` and touches no DOM, network, storage or clock.
- The portability argument survives. If a phone version is ever built, this is
  dependency-free logic that can be ported or run behind a small service. That is
  a weaker guarantee than sharing one artefact, and it is the honest trade.
- Types are shared between the engine and the tool-call boundary for free, which
  is where they are worth the most.
