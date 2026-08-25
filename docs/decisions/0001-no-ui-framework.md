# ADR-0001 — No UI framework, no CSS framework

**Date:** 2026-08-25
**Status:** Accepted
**Requirement:** R-50, plan §8

## Context

The page has one route, roughly nine components, and no shared state beyond a
single conversation. The visual identity is a stated product requirement: the
owner's brief says plainly that it must not look like a generated page, and
plan §5.2 turns that into a list of forbidden patterns.

React, Vue or Svelte would each add 40–120KB to a 2MB budget for an application
this small. That is the cheap objection. The expensive one is that a framework
brings a default look — and so does every component library and every CSS
framework — and a default look is exactly the thing R-50 forbids. Tailwind's
output is legible as Tailwind at a glance.

## Decision

Hand-written TypeScript and hand-written CSS. No UI framework, no component
library, no CSS framework, no state-management library.

The cost is accepted deliberately: DOM updates are written by hand, and there is
no reactivity system to lean on.

## Consequences

- The bundle target is <120KB gzipped and is a CI gate. Nothing in the app's
  runtime comes from `node_modules`.
- All rendering goes through `textContent` and explicit node construction.
  `innerHTML` is banned by an ESLint rule with exactly one audited exception,
  the hand-authored SVG diagram.
- The stylesheet is roughly 600 lines with a token block at the top, and
  `scripts/check-design-rules.mjs` fails the build on a gradient, a blur, a
  coloured box-shadow, a border radius above 4px outside a small allowlist, or a
  raw hex outside `tokens.css`.
- Components are plain factory functions returning an element plus an update
  method. There is no diffing, so each component owns its own DOM updates.
- If this project grew a second route or shared cross-component state, this
  decision would be worth revisiting. It has neither.
