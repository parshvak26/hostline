# Progress

Task-by-task status against `docs/planning/project_plan.md` §20. A fresh session
should be able to read this file and resume exactly where the last one stopped.

**Legend:** `done` · `partial` · `todo` · `blocked` (with the reason)

---

## Standing constraint on this build

**No git operations were performed.** The operator instructed that nothing be
committed or pushed, which overrides the build prompt's Phase 0 instruction to
create `parshvak26/hostline` and enable Pages. Consequently:

- there is no git history, no remote, and no deployment;
- every acceptance criterion phrased as "live at the URL", "green CI", "pushed",
  or "clean over full history" is **blocked**, not failed;
- everything else is built, runnable, and tested locally.

`RUNBOOK.md` Part 3 has the exact commands to publish it.

---

## Verified state, last run 2026-08-25

| Check | Result |
|---|---|
| `npx vitest run` | **1,250 passing**, 28 files, 0 skipped |
| `npm run test:worker` | **124 passing**, 5 files |
| Engine statement coverage | **98.46%** (gate: 90%) |
| `npx eslint .` | clean |
| `npx tsc --noEmit` (web + worker) | clean |
| `npx stylelint "src/**/*.css"` | clean |
| `node scripts/check-design-rules.mjs` | clean across 11 stylesheets |
| `npm run build` | succeeds; JS 44.1 KB gz, CSS 5.0 KB gz, total 146.0 KB gz (budget 2 MB) |
| `npm run test:e2e` | **chromium green: 28 passed, 1 skipped.** Firefox 23/29. WebKit and iPhone SE could not run on this machine at all. See the note below. |
| `node scripts/check-no-secrets.mjs` | clean |
| `npm run converse -- --demo` | completes a booking |
| `npm run seed` | demo moment verified: exactly 3 alternatives |
| `npm run measure-latency` | rule brain p50 0.05 ms, p95 0.09 ms |
| Booking in a real browser (Chromium, typed) | completes; reference issued; zero console errors |
| 375x667 | Talk button above the fold, 56 px tall; **no horizontal scroll** through a full booking |
| 200% zoom (640x400) | full booking completes; **no horizontal scroll** |

### The end-to-end suite, stated accurately

14 specs, 29 tests per project. What actually ran:

| Project | Result |
|---|---|
| **chromium** | **Green — 28 passed, 1 skipped** (the skip is `mobile.spec`, scoped to the phone profiles). Verified twice. |
| **firefox** | 23/29. The six that press the Talk button fail: on Playwright's Firefox build, `new AudioContext()` inside the click handler hangs the tab. Proved environmental by injecting a fake `AudioContext` — the same click then completes in 839 ms. |
| **webkit** | **Could not run at all.** Playwright 1.49.1 pins WebKit 18.2 for macOS 15; this machine is macOS 26.5.1. No navigation completes — even `goto('data:text/html,<h1>hi')` times out. Needs a newer Playwright or a macOS 15 runner. |
| **iphone-se** | Could not run — it is a WebKit project. |
| **pixel-5** | Attempted only after the host fault below; results are not meaningful. |

**Then the machine's audio stack wedged**, and the suite became unrunnable
entirely. `say -v '?'` hangs at the shell, and in every browser mode merely
reading `window.speechSynthesis` blocks the renderer permanently. A bare
`new AudioContext()` on `about:blank` — no project code loaded at all — also
hangs. Recovery is `sudo killall coreaudiod`, or a reboot, then
`npm run test:e2e`.

**Do not read the chromium-green result as "the suite passes everywhere."** It
passes on Chromium. Firefox has an environmental blocker. WebKit was never
exercised on this machine, so Safari and iOS are **untested**, and plan §23 asks
for all three — that box is not ticked.

Three real defects came out of writing the suite, all fixed:

- **The agent had no voice at all in the default build.** `SpeechCascade`
  implemented `speakOrResolve` but not `speak`, and the orchestrator calls
  `speech.speak?.(…)` optionally — so the missing method was `undefined` and the
  call silently did nothing. Fixed, with `tests/unit/speech-cascade.test.ts` (9
  tests) asserting the observable outcome rather than the method's existence.
- **Every spoken visitor turn was printed twice**, because a final recognition
  result reached the transcript through both `onTranscript` and the endpointer.
  `handleTurn` is now the single writer.
- **`AudioQueue.isUnlocked()` constructed an `AudioContext` as a side effect**,
  so merely asking whether audio worked took a lock on the platform's audio
  stack. It is now a plain read.

---

## Phase 0 — Foundation (T-001 … T-009)

| Task | Status | Notes |
|---|---|---|
| T-001 Initialise repository | partial | All files present. Node 24 per plan §0 (not 20). Repo creation blocked. |
| T-002 Vite + TypeScript strict | done | `base: '/hostline/'`; verified by serving the built output. |
| T-003 Lint rules incl. engine purity | done | Proven by `tests/unit/lint-rules.test.ts`. |
| T-004 Test scaffolding | done | Vitest with the coverage gate; Playwright across 5 profiles. |
| T-005 CI workflow | done | `ci.yml` with parallel lint/typecheck/gitleaks/unit/worker/build/e2e jobs. Never executed on GitHub. |
| T-006 Pages deployment | partial | `deploy-pages.yml` written; deployment blocked. |
| T-007 Design tokens and stylesheet | done | Fraunces subset to 39.6 KB. Grep check enforces §5.2. |
| T-008 Restaurant config and validator | done | 28 tests, 12 malformed variants with distinct messages. |
| T-009 ADR-0001 no framework | done | Plus five more ADRs. |

## Phase 1 — Booking engine (T-020 … T-035) — **complete**

| Task | Status | Notes |
|---|---|---|
| T-020 Engine types | done | Rejection reasons are a closed union. |
| T-021 Date parser | done | 79 tests. |
| T-022 Time parser | done | 63 tests, plus 24-hour word forms added after a fixture gap. |
| T-023 Party-size parser | done | 85 tests. |
| T-024 Name parser | done | 84 tests. |
| T-025 Phone parser | done | 52 tests. |
| T-026 Validation layer | done | 67 tests. Never throws; fields validated independently. |
| T-027 Availability engine | done | 62 tests. Exactly plan §10.5, plus slot-grid snapping for off-slot times. |
| T-028 State machine | done | 67 tests. |
| T-029 Confirmation policy | done | 65 tests. Affirmation classified by the engine from the visitor's own words. |
| T-030 Prompt selection | done | 30 tests. |
| T-031 Rule brain | done | Includes cross-parser arbitration (longest-claim-wins, bare-number rule). |
| T-032 Fixture corpus | done | **113 utterances, 32 conversations.** Task completion 100%, mean 4.89 turns to booking. Zero skips. |
| T-033 **Adversarial suite** | **done** | **26 tests, all 14 plan cases.** Verified to fail loudly when the engine is weakened. |
| T-034 Diary seeding | done | 12 tests. Friday 19:00 for four → refused, exactly 3 alternatives (20:15/20:30/20:45). |
| T-035 Terminal runner | done | `npm run converse -- --demo`. |

**Five engine bugs were found by the test agents and fixed rather than papered
over:** rejections were being dropped from state (breaking the transcript
viewer's whole purpose); a proposal after commit reopened a committed
conversation; the failure counter reset on every turn, making the §4.3
escalation ladder unreachable; six refusal phrases were never spoken; the
off-topic path captured questions as the customer's name.

## Phase 2 — Voice in the browser (T-040 … T-049)

| Task | Status | Notes |
|---|---|---|
| T-040 Port interfaces | done | |
| T-041 Web Speech adapter | done | Restart-on-end handling, full error mapping. |
| T-042 Endpointing | done | 28 tests. Pure, injected clock, fires once per turn. |
| T-043 Audio queue | done | 19 tests. `flush()` asserted synchronous. |
| T-044 Browser speech adapter | done | Voice ranking, `voiceschanged` handling. |
| T-045 Energy VAD | done | 18 tests. Wired via `Orchestrator.onMicrophoneEnergy`. |
| T-046 Turn orchestrator | done | Brain selection, filler, timeout, barge-in, latency marks. |
| T-047 IndexedDB repository | done | 42 tests, conformance suite run against both implementations. |
| T-048 UI shell | done | Delivered in full as part of Phase 5. |
| T-049 Echo handling | partial | `echoCancellation: true` plus gating during playback. **Manual cross-browser check not performed** — no three-browser manual pass was possible. |

## Phase 3 — Gateway and AI brain (T-060 … T-071)

| Task | Status | Notes |
|---|---|---|
| T-060 Worker scaffold | done | Router, CORS, `/health`. |
| T-061 Turnstile + session tokens | done | 22 tests incl. tamper, expiry, fail-closed on an unreachable verifier. |
| T-062 Quotas and kill switch | done | 27 tests. **Write-coalescing asserted**: 100 turns cost ≤1 KV write per minute. |
| T-063 `/chat` SSE proxy | done | 29 tests incl. ~128 chunk-boundary split variants. |
| T-064 `/speak` proxy | done | 22 tests. Streaming asserted, not just status codes. |
| T-065 `/listen` proxy | done | 24 tests. Size check before the body is read. |
| T-066 Gateway client | done | SSE reassembly, abort on every request, status→degradation mapping. |
| T-067 Tool schema | done | Consistency test binds it to the engine's slot list. |
| T-068 LLM brain | done | Written and typechecked. **Never run against a live model.** |
| T-069 Engine validation of tool calls | done | True by construction; both brains reach the engine only via `tool_call`. |
| T-070 Brain selection and fallback | done | 400 ms filler, 2.5 s timeout, rule mode after 3 failures. |
| T-071 Hosted recognition fallback | done | Written and selected correctly (Firefox and iOS route here when a gateway exists). **Never run against a live gateway.** |

## Phase 4 — Smoothness (T-080 … T-087)

| Task | Status | Notes |
|---|---|---|
| T-080 Phrase inventory | done | 38 keys, **34 bakeable** (R-26 wants ≥20). |
| T-081 Audio baking script | partial | Script written and dry-run verified. **Cannot be run — needs a Groq key.** CI check reports the gap without failing. |
| T-082 Cache-first speech adapter | done | prebaked → hosted → browser, rung skipped not retried. |
| T-083 Sentence chunking | partial | `createSentenceStream` written and `onFirstToken` wired to cancel the filler. **Streaming the model's prose to speech is deliberately not wired** — the engine's line wins for nearly every turn, so it would speak something then superseded. Documented honestly in `docs/latency.md` and `docs/architecture.md`. |
| T-084 Warm-up sequence | done | Idle-time warm; the "warming up" label only appears past 800 ms. |
| T-085 Upstream barge-in cancellation | done | Flushes audio *and* aborts chat and speech. `tests/e2e/barge-in.spec.ts` asserts the stop and that the agent does not resume the interrupted line, on all five profiles. |
| T-086 Filler on slow brain | done | Never twice in a row. |
| T-087 Latency instrumentation | done | On-screen readout plus `scripts/measure-latency.ts`. |

## Phase 5 — Design and diary (T-100 … T-110)

| Task | Status | Notes |
|---|---|---|
| T-100 Full visual pass | done | Grep check clean across 11 stylesheets. Screenshotted and reviewed; `npm run screenshots` regenerates the README images from the built site and fails on a console error. |
| T-101 Listening indicator | done | 18 tests. A hand-built chart-recorder trace driven by real RMS; static under reduced motion. |
| T-102 Slot panel states | done | 23 tests. Four states distinguished by weight, slope and marker — legible in greyscale. |
| T-103 Confirmation card | done | Focus moves on completion and is returned. |
| T-104 Diary view | done | New booking marked by a 2px rule plus the word "new", never a fill. |
| T-105 Transcript viewer with rejections | done | 26 tests. Refusals attached to the turn that produced them, never hidden behind a toggle. |
| T-106 "How this works" | done | 17 tests. Hand-authored SVG, 150-word explanation, 136-word `<desc>`. |
| T-107 Responsive pass | done | Breakpoints per §5.5. **Verified in Chromium**: a full booking completes at 375x667 and at 200% zoom with no horizontal scroll at any stage. Two real layout bugs were found and fixed doing so — a flex item's `min-width: auto` and an implicit `auto` grid track. |
| T-108 Accessibility pass | done | Live regions, focus management, `Esc` to interrupt, skip link. **axe-core run on every view across all five profiles: zero serious or critical violations.** A keyboard-only booking completes. |
| T-109 Recorded conversation | **blocked** | Needs a real microphone and a person. `public/demo/README.md` explains, and the fallback panel degrades cleanly without it — its player is now built on first reveal rather than on construction, so a healthy page load makes no request for it. |
| T-110 Catastrophic fallback panel | done | Installed before anything else runs; three independent try/catch blocks. `tests/e2e/catastrophic.spec.ts` proves an injected error reveals it rather than blanking the page. Its player is built on first reveal, so a healthy load makes no request for the absent recording. |

## Phase 6 — Credibility (T-120 … T-125)

| Task | Status | Notes |
|---|---|---|
| T-120 README | done | Limitations written before features, per §24. Every number measured. |
| T-121 Documentation set | done | architecture, ai-boundary, degradation, latency, self-hosting. **`self-hosting.md` has not been followed on a clean machine** and says so. |
| T-122 Publish measured numbers | partial | Rule-brain latency, bundle sizes and coverage are real. **AI-mode latency and Lighthouse do not exist** and are marked as such rather than estimated. |
| T-123 Lighthouse gate | partial | `lighthouse.yml` written; never executed (needs a deployed preview). |
| T-124 Final security pass | partial | `check-no-secrets.mjs` clean on the bundle; CSP verified in the built output; no personal data in fixtures. **gitleaks over history is impossible — there is no history.** |
| T-125 Repository presentation | partial | Social preview image drawn at `public/og-image.png` (same palette and face as the site, generated by `scripts/make-og-image.py`); Dependabot and issue templates added. The About line and topics need a repository — commands are in `RUNBOOK.md` Part 3 Step 4. |

---

## Blocked on repository operations

| Criterion | Source |
|---|---|
| Public repo `parshvak26/hostline` exists | build prompt, Phase 0 |
| Pages enabled with Actions as the source | build prompt, Phase 0 |
| A live site at `https://parshvak26.github.io/hostline/` | Phase 0 gate |
| CI green on a pull request | T-005, T-006 |
| `gitleaks` clean over full history | plan §23, T-124 |
| Lighthouse scores from a CI run | plan §23, T-123 |
| Repository About line, topics, social preview | T-125 (the image exists at `public/og-image.png`) |

## Blocked on the operator's own accounts

| Criterion | Why |
|---|---|
| Prebaked audio in `public/audio/` | Needs a Groq key. Script ready; `npm run bake-audio`. |
| Groq free-tier verification (plan §0) | Needs an account. Recorded as an open action in ADR-0006. |
| Worker deployed; gateway URL known | Needs a Cloudflare login. |
| Adversarial suite re-run "with the real model in the loop" | Needs a key. The suite is model-agnostic and passes. |
| Measured AI-mode latency | Needs a deployed gateway. |
| The session handshake proven end to end | Written and typechecked; never run against a live gateway. |

## Blocked on things a build cannot do

| Criterion | Why |
|---|---|
| The ≤45s recorded conversation (T-109) | Needs a microphone and a person. |
| "Three people who don't know the project say it doesn't look AI-made" | Needs three people. |
| Manual three-browser echo check (T-049) | Needs three browsers and a speaker. |
