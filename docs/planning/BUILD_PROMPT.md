Build the Hostline project, end to end, autonomously.

## Read these first, in full, before writing any code

- `/Users/mac/Desktop/Git/hostline/project_goal.md` — what the product is and why (approved, revision 3)
- `/Users/mac/Desktop/Git/hostline/project_plan.md` — how to build it (30 sections, ~1700 lines, approved)

`project_plan.md` is your specification. It contains the confirmed build parameters (§0), the requirement IDs (§2), the architecture (§7), the exact repository layout (§9), the data model and availability algorithm (§10), the gateway API contract (§11), the AI tool schema and safety rules (§12), the testing strategy including the 14 adversarial cases (§16), the six phases with acceptance criteria (§19), and the ~60 numbered tasks T-001…T-125 (§20). Follow it. Do not redesign it.

## Confirmed parameters

- GitHub: `parshvak26`. The GitHub CLI is already authenticated on this machine.
- Repo: `parshvak26/hostline`, public, MIT.
- Live site: `https://parshvak26.github.io/hostline/`
- Work in: `/Users/mac/Desktop/Git/hostline/` — this is the repo root. Move `project_goal.md`, `project_plan.md`, and this file into `docs/planning/` and commit them; they are part of the portfolio story.
- AI providers: **Groq** for the LLM brain, TTS, and hosted speech recognition. One account, one key.
- Display font: **Fraunces**, self-hosted and subset. Body text: system sans stack.
- Demo restaurant: Ember & Oak · est. 2019 · Bandra · `Asia/Kolkata` · locales `en-IN` (default) and `en-US`.

## Autonomy rules — the user is away and will not answer questions

- **Never stop to ask a question.** When something is genuinely ambiguous, choose the option that best serves the plan's stated priorities (works > feels good > looks good > documented), write a short ADR in `docs/decisions/`, and continue.
- **Never fabricate a measured number.** Latency, coverage, and Lighthouse figures go in the README only after a real run produces them. If a target is missed, publish the real number and explain why in `docs/latency.md`.
- **Never commit a secret.** The Groq key must never appear in this repository, in any file, in any commit, or in any log. The browser bundle may contain only the public gateway URL and the public Turnstile site key.
- **Never weaken a test to make it pass.** If the adversarial suite fails, the engine is wrong — fix the engine.
- **Never skip the design constraints.** No gradients, no glow, no backdrop-blur, no border-radius above 4px outside the allowlist, no UI framework, no CSS framework. §5.2 of the plan is binding and CI greps for violations.

## How to manage a long run

This is a large build. Protect your context:

1. Create `PROGRESS.md` in the repo root immediately. List every task ID from plan §20 with a status. Update it as you go and commit it. **A fresh session must be able to read `PROGRESS.md` and resume exactly where you stopped.**
2. Delegate bulk implementation to subagents so their file-reading stays out of your context. Keep the architecture decisions, the engine design, and the integration work yourself.
3. Commit in small, meaningful units with clear messages. Push after every phase.
4. If you are running low on context, finish the task in hand, update `PROGRESS.md`, commit, push, and report where you stopped. Do not start something you cannot finish.

## Parallelism — use it, but only where file sets are disjoint

Run subagents concurrently at these four points. Give each agent an exclusive list of files it owns; no two concurrent agents may touch the same file.

- **Phase 1, after `src/engine/types.ts` exists:** five agents in parallel, one per parser — `date.ts`, `time.ts`, `party.ts`, `name.ts`, `phone.ts` — each writing its implementation *and* its unit tests. Then converge and integrate yourself.
- **Phase 3, after the worker scaffold, session, and quota modules exist:** three agents in parallel for `chat.ts`, `speak.ts`, `listen.ts` plus their `providers/` module and Miniflare tests.
- **Phase 5, after the visual pass:** four agents in parallel for `listening-indicator`, `slot-panel`, `diary-table` + `transcript viewer`, and `confirmation-card` + `fallback-panel`.
- **Phase 6:** four agents in parallel for `architecture.md`, `ai-boundary.md`, `degradation.md` + `latency.md`, and `self-hosting.md`.

Everything else is sequential. The engine, the orchestrator, and the integration between layers are yours alone.

## Build order and push gates

Work through plan §29 and §19. After each phase: run the full test suite, commit, push, and confirm the phase's acceptance criteria in `PROGRESS.md`. **Do not begin a phase until the previous phase's acceptance criteria pass.**

**Phase 0 — foundation (T-001…T-009).**
Create the public repo with `gh repo create parshvak26/hostline --public --source=. --remote=origin`. Enable Pages with Actions as the source (`gh api -X POST repos/parshvak26/hostline/pages -f build_type=workflow`, and verify it took). Set `base: '/hostline/'` in `vite.config.ts` — a wrong base path is the single most common Pages failure. Add the engine-purity and no-`innerHTML` lint rules now, not later.
→ **Gate: a styled placeholder is live at the URL and CI is green.**

**Phase 1 — booking engine (T-020…T-035).**
This is the heart of the project. Pure TypeScript, zero dependencies, no DOM, no network, no `Date` — the lint rule enforces it. Build the availability algorithm exactly as plan §10.5 specifies, including best-fit allocation and the alternatives search. Write the fixture corpus. **Write all 14 adversarial cases from plan §16.2 and make them a CI gate.** Seed the diary so next Friday 19:00 is deliberately full.
→ **Gate: ≥90% statement coverage on `src/engine/`, every fixture passes, all 14 adversarial cases rejected, and `scripts/converse.ts` completes a booking from the terminal.**

**Phase 2 — voice in the browser (T-040…T-049).**
Web Speech recognition, endpointing, the interruptible audio queue, browser speech synthesis, energy-based barge-in detection, the orchestrator turn loop, IndexedDB, and a minimal but semantically correct UI.
→ **Gate: a spoken booking completes on the live Pages URL with no backend and no AI. Push. The user now has something real.**

**Phase 3 — gateway and AI brain (T-060…T-071).**
Build the Cloudflare Worker (sessions, Turnstile, quotas per plan §11 including the coalesced KV write strategy, kill switch, and the three streaming proxies). Build the gateway client, the tool schema, and the LLM brain. **Route every tool call through engine validation — the model may propose, only the engine may commit.** Implement brain selection and the full fallback chain.
Verify Groq's current free tier before committing to it; if it has changed, use the fallback order in plan §0 and record the decision. You cannot deploy the worker (that needs the user's login) — so write it, test it under Miniflare, and leave `worker/wrangler.toml` ready with the gateway URL configurable via a repository variable. The site must remain fully working in rule mode until the user deploys.
→ **Gate: `tests/e2e/no-gateway.spec.ts` completes a booking with the gateway blocked at the network layer. Worker tests pass. The adversarial suite still passes.**

**Phase 4 — smoothness (T-080…T-087).**
Phrase inventory, the build-time audio baking script, cache-first speech resolution, sentence-boundary chunking, the warm-up sequence, upstream barge-in cancellation, fillers at 400ms, and latency instrumentation. Baked audio requires a Groq key, which you do not have — so write `scripts/bake-audio.ts`, commit it, add a CI check that every phrase key has a matching baked file, and put a clear note in the runbook telling the user to run it once after adding their key. Until then the browser voice covers every line.
→ **Gate: barge-in stops audio in under 150ms with the upstream request confirmed aborted; no dead air longer than 400ms in any fixture conversation.**

**Phase 5 — design and diary (T-100…T-110).**
The full visual pass per plan §5.2, the hand-built listening indicator, slot state transitions, the confirmation card, the diary, the transcript viewer that **displays every AI proposal the engine rejected**, the hand-authored SVG diagram, the responsive pass, the accessibility pass, and the catastrophic fallback panel.
→ **Gate: every flow completes at 375×667 and at 200% zoom; zero serious or critical axe violations; a grep finds no gradient, blur, coloured box-shadow, or radius >4px outside the allowlist.**

**Phase 6 — credibility (T-120…T-125).**
README per plan §24 (write the limitations section *before* the features section), the five docs, the ADRs, the Lighthouse gate, the security pass, and repository presentation — About line, topics, social preview.
→ **Gate: `docs/self-hosting.md` is accurate; gitleaks is clean over full history; every published number traces to a real run.**

## When you finish

1. Run the full suite one final time. Push.
2. Update `PROGRESS.md` to show everything complete.
3. Write `RUNBOOK.md` in the repo root containing, in plain non-technical English:
   - the live URL and what already works without any setup
   - exactly how to create the Cloudflare and Groq accounts
   - the exact commands to add the key, deploy the worker, bake the audio, and point the site at the gateway
   - how to flip the kill switch
   - how to check whether the AI is on or the site is in simple mode
   - what to do if something looks wrong
4. Report back with: the live URL, what works right now, what turns on after the user's 5-minute setup, every deviation you made from the plan and why, and any acceptance criterion you could not meet.

## What "done" means

Plan §23. Do not report completion until every box in it is genuinely ticked, or you have explicitly listed the ones that are not and why.

Begin with Phase 0.
