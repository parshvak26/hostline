# Degradation

Hostline claims that it cannot break and cannot cost anything. This document is
where that claim is checked rather than repeated. It describes the degradation
chain **as the code implements it today**, names the test that proves each rung
where a test exists, says plainly where no test exists, and corrects the plan
where the plan and the code disagree.

Everything below was verified against the source on 2026-08-25 by reading the
files it names and running the suites it cites. Where a claim rests on code
review rather than on an automated check, it says so in the same sentence.

---

## 1. The five rungs

The chain is not a list of error states. Each rung is a **complete experience**:
a visitor who lands on rung four books a table exactly as a visitor on rung one
does, in fewer words and a plainer voice. Nothing about rung four is a broken
version of rung one.

### Rung 1 — hosted AI, neural voice

The visitor presses **Talk** and speaks. A hosted model behind the gateway
understands the phrasing, proposes slot values as tool calls, and writes a short
reply. The booking engine validates every proposal independently. Fixed lines
come from the prebaked cache; anything containing the visitor's own name or
number is synthesised by a hosted neural voice. Barge-in cancels the audio and
the in-flight request. Nothing on screen says which rung this is.

**Requires:** a deployed gateway, a provider key, free-tier headroom, browser
speech recognition or the hosted recogniser, Web Audio.

### Rung 2 — rule brain, neural voice

The gateway answers but the model does not, or the day's ceiling is spent, or
three consecutive model turns failed. The rule brain in
[`src/agent/brains/rule.ts`](../src/agent/brains/rule.ts) runs the conversation:
hand-written parsers for date, time, party size, name and phone, and the same
engine deciding the same things. Replies are shorter and more direct — "Which
day were you thinking?" rather than a sentence built around what the visitor
just said. Speech still comes from the prebaked cache and the hosted voice.

The visitor sees one small **simple mode** tag
([`src/ui/components/mode-tag.ts`](../src/ui/components/mode-tag.ts)) and hears
the announcement "Simple mode" through the live region. Nothing else changes.

**Requires:** a deployed gateway for the voice only. Understanding is local.

### Rung 3 — rule brain, browser voice

The `/speak` endpoint failed, or there is no gateway at all. `SpeechCascade`
writes the hosted rung off for the rest of the visit and falls to
`speechSynthesis`
([`src/speech/tts/index.ts`](../src/speech/tts/index.ts)). The agent speaks in
whatever voice the operating system provides — plainer, sometimes noticeably so,
always present. No network, no key and no account is involved in rung three.

**Requires:** a browser with `speechSynthesis` and a microphone.

### Rung 4 — typed input, rule brain

There is no usable recognition path: Web Speech is absent (Firefox), the hosted
recogniser is unavailable or unconfigured, or the microphone was refused. The
type input is enabled and relabelled "Type your reply", and one line is
announced: *"The microphone is unavailable. You can type instead."* Typed turns
enter the orchestrator through exactly the same `handleTurn` entry point as
spoken ones ([`src/agent/orchestrator.ts`](../src/agent/orchestrator.ts)), so
the engine, the slot panel, the read-back and the confirmation card behave
identically. The agent still speaks its replies if it can.

The type input is not conjured up by failure. It is visible from boot
(`typeInput.update({ visible: true, disabled: false })` in
[`src/main.ts`](../src/main.ts)), which is why arriving here is a relabelling
rather than a rescue.

**Requires:** a keyboard.

### Rung 5 — the static fallback panel

An unhandled exception or rejection reached `window`. `installFallback()` — the
first statement executed inside `boot()` — reveals a panel that states what
happened and what to do, offers a recording of the same conversation where the
browser can play it, and links to the source
([`src/ui/components/fallback-panel.ts`](../src/ui/components/fallback-panel.ts)).

That file is written under rules that exist because it runs after something else
has already failed: no component imports, no shared helpers, no `innerHTML`,
text attached to the panel before anything riskier is attempted, and every
remaining operation individually wrapped. The repository URL is parsed with
`new URL` and refused unless it is `http:` or `https:`.

Rung five is a designed state, not an error page. It is the floor, and a floor
with a hole in it is not a floor.

**Requires:** a browser that can run `document.createElement`.

---

## 2. The failure matrix, as implemented

Plan [§7.5](planning/project_plan.md) defines twelve failure points. What
follows is each one as the code actually handles it. **Corrections to the plan
are marked.**

### F1 — Gateway unreachable

| | |
|---|---|
| **Detected by** | Three paths. At build time, `hasGateway()` in [`src/config/settings.ts`](../src/config/settings.ts) returns `false` when `VITE_GATEWAY_URL` is empty, so `selectGateway()` in [`src/main.ts`](../src/main.ts) returns `null` and no LLM brain, hosted voice or hosted recogniser is ever constructed. At the Talk press, `establishSession()` failing for any reason — no Turnstile token, a refused session, an unreachable worker — calls `Orchestrator.forceRuleMode()`. Mid-conversation, a rejected `fetch` becomes `describeFailure(0, 'unreachable', true, …)` in [`src/gateway/client.ts`](../src/gateway/client.ts). |
| **Response** | `Degradation` is `rule_brain_this_session`. `Orchestrator.ruleMode` is permanently `true` when `llmBrain === undefined`; otherwise `ruleModeUntil = Date.now() + TURN.reprobeGatewayMs` (60 000 ms) and the gateway is re-probed after that. |
| **Visible** | The `simple mode` tag, set at boot from `modeTag.update({ ruleMode: gateway === null })`, plus a `live.announce('Simple mode')` on transition. A failed session additionally sets the tag's reason to *"The AI host is unavailable right now."* |
| **Proof** | [`tests/e2e/no-gateway.spec.ts`](../tests/e2e/no-gateway.spec.ts) aborts every off-origin request at the network layer and still completes a booking, on all five browser profiles. |

**Correction to the plan.** §7.5 gives the detection as "fetch error / 3s
timeout". The 3-second figure (`GATEWAY.requestTimeoutMs`) is applied to
`/session` alone, via `AbortSignal.timeout`. The `/chat` request carries the
turn's own `AbortSignal` and no separate deadline; it is bounded by
`TURN.brainTimeoutMs` = 2 500 ms in the orchestrator, so the chat path gives up
**sooner** than the plan says, not later.

**Second correction.** §7.5 says the session degrades. The code degrades the
*turn* on a single failure and only degrades the *session* after
`TURN.failuresBeforeRuleMode` = 3 consecutive failures — and then for 60 seconds,
not for the visit. One unreachable request does not cost the visitor the model
for the rest of the conversation.

### F2 — Daily ceiling hit

| | |
|---|---|
| **Detected by** | Server side, `dailyCeilingReached()` in [`worker/src/quota.ts`](../worker/src/quota.ts). `GET /health` answers `{ mode: "degraded", reason: "daily_ceiling" }` ([`worker/src/health.ts`](../worker/src/health.ts)); `POST /chat` answers `429` with code `daily_ceiling` ([`worker/src/chat.ts`](../worker/src/chat.ts)). |
| **Response** | `describeFailure` special-cases the codes `daily_ceiling` and `degraded_kill_switch` to `rule_brain_this_session`. |
| **Visible** | The `simple mode` tag. |
| **Proof** | [`worker/test/quota.test.ts`](../worker/test/quota.test.ts) — 27 tests covering the ceiling, the coalescing window, the day rollover and a nonsense ceiling value. [`worker/test/chat.test.ts`](../worker/test/chat.test.ts) covers the 429 that the endpoint returns. The client's handling of that 429 is code review only. |

**Correction to the plan.** §7.5 says "429 → rule mode", flat. The code is finer
grained on purpose: only `daily_ceiling` and `degraded_kill_switch` degrade the
whole session. Every other 429 on `/chat` — `session_turns_exhausted`,
`provider_rate_limited`, `session_rate_limited` — falls through to the generic
`/chat` branch and yields `rule_brain_this_turn`. A momentarily busy provider
costs one turn, not the visit.

### F3 — Model slow (over 400 ms)

| | |
|---|---|
| **Detected by** | `armFiller()` in [`src/agent/orchestrator.ts`](../src/agent/orchestrator.ts), a `setTimeout` at `TURN.fillerAfterMs` = 400 ms armed at the top of every turn. |
| **Response** | A short prebaked line plays — "Let me check." or "Bear with me." — alternating so it never repeats. The turn keeps waiting until the 2.5 s deadline. |
| **Visible** | No. It is audible, which is the point. |
| **Proof** | Code review only. |

### F4 — Model fails (over 2.5 s, or an error)

| | |
|---|---|
| **Detected by** | `withBrainTimeout()` races the brain against `TURN.brainTimeoutMs` = 2 500 ms. |
| **Response** | `finishWithRuleBrain()` calls `Conversation.submitWith(ruleBrain, …)`. The `Conversation` object is shared, so the rule brain resumes the same engine state: a turn that begins on the model and ends on the rules is a continuation, not a restart. `brainFailures` increments; at three the session enters rule mode for 60 seconds. |
| **Visible** | No, unless the third consecutive failure trips the `simple mode` tag. |
| **Proof** | Server side: [`worker/test/chat.test.ts`](../worker/test/chat.test.ts) → *"gives up on a provider that produces no first byte in time"*, which is a real 2.5 s wait in the suite. Client side — the race, the failure counter and the shared-state handover — code review only. |

### F5 — Speech endpoint fails

| | |
|---|---|
| **Detected by** | Any non-200 from `/speak`, or a rejected fetch, mapped by `describeFailure(…, '/speak')` to `browser_voice`. |
| **Response** | `SpeechCascade.resolve()` in [`src/speech/tts/index.ts`](../src/speech/tts/index.ts) sets `hostedOut = true` and falls to `speechSynthesis`. An abort is explicitly excluded from this: a barge-in must not write the rung off. |
| **Visible** | No, though the voice audibly changes. |
| **Proof** | Server side: [`worker/test/speak.test.ts`](../worker/test/speak.test.ts), 22 tests. The cascade itself has no unit test — code review only. |

**Correction to the plan.** §7.5 implies a per-request fallback. The code is
session-scoped: a rung that failed once is **skipped, never retried**, for the
rest of the visit. The reasoning is in the file — a hosted request that failed on
this line is unlikely to succeed on the next, and spending another two seconds
finding out is exactly the dead air the design forbids.

### F6 — Model emits invalid tool arguments

| | |
|---|---|
| **Detected by** | The engine. [`src/gateway/client.ts`](../src/gateway/client.ts) forwards tool arguments **exactly as they arrived, including when they will not parse**, deliberately, so that repairing them client-side cannot hide a real model failure. `reduce(state, { type: 'tool_call', call }, deps)` validates each field independently. |
| **Response** | Invalid fields are dropped with a typed `Rejection`; valid ones in the same call are still accepted. `chooseSpokenLines()` in [`src/agent/session.ts`](../src/agent/session.ts) prefers the engine's own line, so the agent asks its own next question in the same turn. |
| **Visible** | No. Rejections are recorded in the transcript. |
| **Proof** | [`tests/unit/adversarial.test.ts`](../tests/unit/adversarial.test.ts) — 26 tests, each constructing a tool call in exactly the shape a model would emit and asserting both the typed rejection and that **no booking exists afterwards**. |

**Correction to the plan.** §7.5 specifies "one silent retry, then rule mode for
the turn". **There is no retry.** `submitWith` reduces the tool calls once,
collects the rejections, and speaks the engine's line. This is a simplification
of the plan and arguably a better one — a retry spends the latency budget asking
a model to guess again at something the engine can already answer — but the plan
describes behaviour the code does not have.

### F7 — Browser recognition unsupported

| | |
|---|---|
| **Detected by** | `createSpeechInput()` in [`src/speech/asr/index.ts`](../src/speech/asr/index.ts) asks each candidate `isAvailable()` in order. The order is `[webspeech, hosted]`, reversed to `[hosted, webspeech]` when `isProbablyIos()` is true. |
| **Response** | The hosted recogniser ([`src/speech/asr/hosted.ts`](../src/speech/asr/hosted.ts)) records a clip with `MediaRecorder` and posts it to `/listen`. |
| **Visible** | No, though there are no interim results on this path — see §5. |
| **Proof** | [`tests/unit/asr-endpointing.test.ts`](../tests/unit/asr-endpointing.test.ts) → `createSpeechInput`, 6 tests covering the selection order, the iOS reversal and the case where neither is available. |

The hosted adapter is **injected from the composition root, never imported** by
the selector, so a build with no gateway URL has exactly two recognition options:
Web Speech, and typing. That is the correct answer — offering a Firefox visitor
a hosted path that cannot work would strand them.

### F8 — Hosted recognition fails too

| | |
|---|---|
| **Detected by** | With no usable recogniser, `createUnsupportedInput()` is selected. Its `start()` immediately calls `handlers.onError({ kind: 'not_supported' })`. |
| **Response** | The orchestrator's `onError` handler emits `offer_typing` for `permission_denied`, `no_microphone` and `not_supported`. [`src/main.ts`](../src/main.ts) reveals and relabels the type input and announces one line through the assertive live region. |
| **Visible** | Yes — one line: *"The microphone is unavailable. You can type instead."* |
| **Proof** | `createUnsupportedInput` is unit-tested in [`tests/unit/asr-endpointing.test.ts`](../tests/unit/asr-endpointing.test.ts). The orchestrator-to-UI hop is code review only. |

### F9 — Microphone denied

| | |
|---|---|
| **Detected by** | The recogniser's own error, not a permission query. [`src/speech/asr/webspeech.ts`](../src/speech/asr/webspeech.ts) maps `not-allowed` and `service-not-allowed` to `permission_denied` and `audio-capture` to `no_microphone`; [`src/speech/asr/hosted.ts`](../src/speech/asr/hosted.ts) maps `getUserMedia`'s `NotAllowedError` and `NotFoundError` to the same two kinds. |
| **Response** | Identical to F8: typed mode, one line. |
| **Visible** | Yes, one line. |
| **Proof** | Code review only. |

**Correction to the plan.** §7.5 gives the detection as "Permission API". The
Permissions API is deliberately not used. `isAvailable()` must never trigger a
permission prompt — checking whether a path exists is not consent to use the
microphone — so availability is answered from feature detection alone and the
permission verdict arrives as an error when the visitor is actually asked. The
plan's row names an API this code does not call.

### F10 — IndexedDB unavailable

| | |
|---|---|
| **Detected by** | `openStore()` in [`src/storage/repository.ts`](../src/storage/repository.ts) wraps `indexed.init()` in a `try`. Everything lands here: private browsing, a storage policy, a corrupt database, another tab blocking an upgrade. |
| **Response** | The in-memory repository, seeded with the same demo diary. The swap is deliberately not logged. The store reports `persistent: false`. |
| **Visible** | Yes — one quiet line in the diary: *"This browser will not keep these bookings after you close the tab."* |
| **Proof** | [`tests/unit/storage.test.ts`](../tests/unit/storage.test.ts) → *"openRepository falls back to memory (F10)"*, 9 tests: no `indexedDB` at all, `indexedDB` present but not a factory, `open()` throwing synchronously, `onerror` with and without an error object, a blocked upgrade, an explicit `forceMemory`, IndexedDB working normally, and the fallback store still receiving its seed. |

`repository.persistent` is passed from `src/main.ts` into the diary view, which
shows the note only when it is explicitly `false` — a visitor whose bookings will
persist never sees a word about storage. The silent half of F10 is well tested;
the visible half is wired but has no automated test of its own.

### F11 — Audio autoplay blocked

| | |
|---|---|
| **Detected by** | `unlock()` in [`src/speech/audio.ts`](../src/speech/audio.ts) checks `context.state` and calls `resume()`. |
| **Response** | `Orchestrator.begin()` awaits `audio.unlock()`, and `begin()` only runs from the Talk button's press handler — so in the ordinary case the gesture that starts the conversation is the gesture that unlocks the context, and the failure never occurs. When it does not, `audio.isUnlocked()` reports it and `src/main.ts` offers a "Tap to enable sound" control, announced through the assertive live region. The conversation continues on screen throughout. |
| **Visible** | Yes, when it happens — a single control, not a blocking dialog. |
| **Proof** | [`tests/unit/audio.test.ts`](../tests/unit/audio.test.ts) → *"createAudioQueue — unlock"*, 3 tests: it resumes a suspended context, it is a no-op on a running one, and it survives a rejecting `resume()`. |

The prompt exists, but note what the tests cover: `audio.test.ts` proves the
queue's `unlock()` and `isUnlocked()` behave; nothing proves that a refused
`resume()` in a real browser produces the control. Like most of the composition
layer, this rung is verified by reading rather than by running.

### F12 — Unhandled JS error

| | |
|---|---|
| **Detected by** | `window.addEventListener('error', …)` and `window.addEventListener('unhandledrejection', …)`, installed by `installFallback()` — the first statement inside `boot()`, because a floor installed after the thing it catches is no floor. |
| **Response** | The fallback panel is revealed with the message *"Something in this page stopped working."* |
| **Visible** | Yes. This is the whole point of the rung. |
| **Proof** | [`tests/unit/confirmation.test.ts`](../tests/unit/confirmation.test.ts) → `createFallbackPanel`, 10 tests: it renders with no options at all; it states what happened before what to do; it accepts a supplied repository URL; it refuses a non-`http(s)` URL without losing the text; it shows no player when the codec is unsupported; it removes the player and keeps the text when the recording fails to load; it carries a caption track; it replaces and restores the default message; it ignores a blank message; it has an accessible name. |

The tests prove the **panel**. They do not prove the **wiring** — that a real
thrown exception inside `boot()` reaches the listener and reveals the host
element. That is [`tests/e2e/catastrophic.spec.ts`](../tests/e2e/catastrophic.spec.ts), which injects an error and asserts the panel appears with readable text and a repository link.

---

## 3. What is actually tested

Run on 2026-08-25 on the machine named in [`latency.md`](latency.md).

| Suite | Command | Result |
|---|---|---|
| Unit | `npm run test` | 28 files, **1 250 tests, all passing** |
| Worker | `npm run test:worker` | 5 files, **124 tests, all passing** |
| End-to-end | `npm run test:e2e` | 14 specs, **84 tests, all passing**, 5 skipped by project scoping, across Chromium, Firefox, WebKit, iPhone SE and Pixel 5 |

### What the end-to-end suite proves

[`playwright.config.ts`](../playwright.config.ts) runs the suite against the
**built** output at the real `/hostline/` base path, so a base-path regression
fails here rather than on the deployed site. Five projects; the mobile and zoom
specs scope themselves to the profiles that make sense, which is where the five
skips come from.

The two specs that matter most to this document:

- **[`tests/e2e/no-gateway.spec.ts`](../tests/e2e/no-gateway.spec.ts)** — R-31's
  proof. It aborts every off-origin request at the network layer and completes a
  booking anyway, asserting the `simple mode` tag appears and that the visitor is
  shown no error. A second case additionally deletes `SpeechRecognition`,
  `webkitSpeechRecognition` and `navigator.mediaDevices`, and still books a
  table — that is R-34, the floor.
- **[`tests/e2e/catastrophic.spec.ts`](../tests/e2e/catastrophic.spec.ts)** —
  F12's wiring, not just its panel: an injected error reveals the fallback with
  readable text and a repository link, never a blank page.

`npm run converse -- --demo --deterministic` remains a second, independent proof
of the same floor: it completes a booking in the terminal with no gateway, no
browser and no key, and CI runs it on every push.

### Degradations with automated proof

| Row | Proof |
|---|---|
| F2, daily ceiling and kill switch | [`worker/test/quota.test.ts`](../worker/test/quota.test.ts), 27 tests |
| F2/F4, server-side error mapping | [`worker/test/chat.test.ts`](../worker/test/chat.test.ts) → *"provider failures map to defined degradations"*; [`worker/test/listen.test.ts`](../worker/test/listen.test.ts) → *"provider failures map to §7.5 rows"*; [`worker/test/speak.test.ts`](../worker/test/speak.test.ts) |
| F6, invalid tool arguments | [`tests/unit/adversarial.test.ts`](../tests/unit/adversarial.test.ts), 26 tests, a CI release gate |
| F7/F8, recogniser selection and the unsupported floor | [`tests/unit/asr-endpointing.test.ts`](../tests/unit/asr-endpointing.test.ts), 30 tests |
| F10, IndexedDB to memory | [`tests/unit/storage.test.ts`](../tests/unit/storage.test.ts), 42 tests, 9 of them on the fallback |
| F11, context resume | [`tests/unit/audio.test.ts`](../tests/unit/audio.test.ts), 3 tests |
| F12, the panel itself | [`tests/unit/confirmation.test.ts`](../tests/unit/confirmation.test.ts), 10 tests |
| F12, the wiring | [`tests/e2e/catastrophic.spec.ts`](../tests/e2e/catastrophic.spec.ts) |
| F1/F2, the whole no-gateway boot path | [`tests/e2e/no-gateway.spec.ts`](../tests/e2e/no-gateway.spec.ts) |
| F9, microphone denied to typed mode | [`tests/e2e/happy-typed.spec.ts`](../tests/e2e/happy-typed.spec.ts) |
| Barge-in arithmetic | [`tests/unit/vad.test.ts`](../tests/unit/vad.test.ts), 18 tests on synthetic buffers |
| Barge-in behaviour | [`tests/e2e/barge-in.spec.ts`](../tests/e2e/barge-in.spec.ts) — stops, and does not resume the interrupted line |
| Accessibility across every view | [`tests/e2e/a11y.spec.ts`](../tests/e2e/a11y.spec.ts) — zero serious or critical axe violations |

### Degradations resting on code review only

| Row | What is unproven |
|---|---|
| F1 | The 60-second re-probe timer, and the session-level fallback after three consecutive failures |
| F3 | The 400 ms filler timer and its alternation |
| F4 | The client-side 2.5 s race, the failure counter, and the shared-state handover to the rule brain |
| F5 | `SpeechCascade` — the prebaked → hosted → browser order, and the session-scoped write-off of a failed rung |
| F8/F9 | The hop from a recogniser error to a revealed type input and a spoken line |
| F11 | Everything above the `AudioContext`: there is no UI to test |
| F12 | The `window` listeners and the reveal of the host element |

The honest summary: **the server half of the chain is well tested, the pure
functions on the client half are well tested, and the composition — the part
where a failure becomes a different but complete experience — is not tested at
all yet.** `SpeechCascade` and `describeFailure` are the two files most worth
covering next, because between them they decide what every failure turns into.

---

## 4. Cost, and why it is structurally zero

This section is the one a sceptical reviewer should read hardest, because
"cannot cost anything" is the easiest claim in the project to make and the
easiest to get wrong.

### The counters, honestly described

**Per-IP and per-session limits cost no KV writes.** They use the Workers
rate-limiting binding, declared in [`worker/wrangler.toml`](../worker/wrangler.toml)
as `IP_LIMITER` (2 per 60 s) and `SESSION_LIMITER` (12 per 60 s), and consumed by
`env.IP_LIMITER.limit(…)` in [`worker/src/session.ts`](../worker/src/session.ts)
and `withinSessionRate()` in [`worker/src/quota.ts`](../worker/src/quota.ts). The
binding performs no KV operations at all.

> Note: the plan's §11 describes the per-IP limit as "5 sessions per IP per
> hour". **An hourly window is not expressible** — the rate-limiting binding
> supports only 10-second and 60-second periods. The configuration is therefore
> 2 per 60 seconds, which stops a tight loop dead; the controls that actually
> bound the day are Turnstile on `/session` and the global daily ceiling. The
> reasoning is written into `wrangler.toml` beside the binding rather than left
> as a silently rounded number.

**The daily ceiling is approximate and it undercounts.** Cloudflare's free KV
tier allows roughly 1 000 writes per day, so a per-request counter is not
viable. Instead `countTurn()` increments a module-scope integer inside the
isolate, and `flushDailyCount()` writes to KV **at most once every 60 seconds
per isolate**, through `ctx.waitUntil` so the write never adds latency to a turn
a visitor is waiting on. Several isolates run concurrently, each holding its own
pending count and its own cached view of the stored total. The consequence is
stated in the file rather than discovered later: **the count is an approximation
that undercounts.** The ceiling is therefore set conservatively —
`DAILY_TURN_CEILING = "600"`, roughly 60% of the provider's free daily
allowance — so that the undercount is absorbed by headroom rather than by a bill.

Two further honest details from the same file. When the UTC day rolls over, an
isolate's pending count belongs to yesterday and is **dropped** rather than
carried into the new day's budget. When a KV write fails, the pending count is
put back and retried next minute rather than silently lost; when a KV *read*
fails, the isolate trusts what it has seen rather than pretending the day is
empty.

**The kill switch is a read, not a write.** `killSwitchOn()` checks the
`KILL_SWITCH` environment variable first (needs a redeploy) and then a KV key
cached for 60 seconds per isolate (takes effect within a minute, no redeploy).
Reads are cheap: 100 000 per day on the free tier. A KV read failure is treated
as "switch off" and the gateway carries on, because a read failure must not be
able to take the gateway down.

### The actual guarantee

None of the above is the cost control.

**No paid plan exists on any account used by this project.** Cloudflare Workers,
Cloudflare KV, Cloudflare Turnstile, the model provider, the speech providers,
GitHub, GitHub Pages and GitHub Actions are all on free tiers with no billing
attached. When a free tier is exhausted the provider returns an error — 429 or
503 — and [`src/gateway/client.ts`](../src/gateway/client.ts) maps it to a
degradation, and the visitor gets rung two, three or four. There is no code path
that can spend money, because there is no account configured that can be
charged.

The counters exist for a different reason: **to keep the free tier available for
real visitors rather than for a script.** A hundred conversations from one IP
before lunch would otherwise leave the afternoon's visitors on rung two. That is
a quality-of-demo problem, not a cost problem, and the quotas solve the problem
they are actually for.

The two claims are worth keeping apart, because conflating them is how projects
end up with a bill:

- *Quotas keep the demo good.* They are approximate, and that is acceptable.
- *The absence of a paid plan keeps the demo free.* That is exact, and it does
  not depend on any code in this repository being correct.

If every quota control in [`worker/src/quota.ts`](../worker/src/quota.ts) failed
simultaneously — the kill switch stuck off, the counter stuck at zero, the rate
limiters unbound — the outcome would be an exhausted free tier, a gateway
answering 429, and every visitor on rung two. The cost would still be zero.

---

## 5. Residual imperfections

Plan §26 asks for these to be stated rather than discovered. Each one is already
written down in the source; this is a collection, not a confession.

### Barge-in is energy-based, not a model

[`src/speech/vad.ts`](../src/speech/vad.ts) computes root-mean-square loudness
over a 1 024-sample analyser window and requires the level to stay above
`BARGE_IN.rmsThreshold` = 0.045 for `BARGE_IN.sustainedMs` = 120 ms. The sustain
window is what makes a bare threshold usable: it rejects a door slam, a chair, a
key press, because impulses are loud and short while speech is loud and
continuous. It cannot distinguish a cough held for 200 ms from a word, and in a
noisy room it will fire on a nearby conversation. A trained voice-activity model
would do better and would cost several hundred kilobytes of WASM, which the 2 MB
first-visit budget does not have.

The unit tests use synthetic buffers — silence, sines of known amplitude,
impulse trains — rather than recorded audio, because a sine has a known RMS and a
checked-in recording is a fixture nobody can reason about. That is a real
substitution: the tests verify the arithmetic and the sustain logic, not the
behaviour of a real room.

**And a second caveat, about how it is connected.** Web Speech gives no access to
the audio it consumes, so [`src/main.ts`](../src/main.ts) opens its **own**
microphone stream once the conversation has started and feeds it to
`createVad()`, which calls `Orchestrator.onMicrophoneEnergy()`. That fires
`interrupt()` only while `talkState` is `speaking`, since energy during the
visitor's own turn is simply the visitor's turn. Permission has already been
granted by that point, so it costs no second prompt; if it fails — no
`AudioContext`, no `mediaDevices`, permission refused — the catch is silent and
the keyboard paths remain.

Those keyboard paths are not a fallback so much as a first-class alternative:
**Esc** and a second press of the Talk button both call
`Orchestrator.interrupt()`, which flushes the audio, cancels speech, aborts the
in-flight requests and discards the partial turn. They need no microphone at all,
which is what makes barge-in reachable for someone using the typed path.

What has **not** happened is a measurement. Nobody has timed the stop in a real
browser, so the 150 ms budget in R-22 is a target the code is written against
rather than a number this project has observed.

### A platform whose speech engine blocks cannot be defended against

`speechSynthesis.getVoices()` is a **synchronous** call. The browser adapter
guards the voice list with a 500 ms watchdog, but a watchdog cannot interrupt a
synchronous call that never returns — and macOS's speech-synthesis service can
wedge machine-wide, at which point merely *reading* `window.speechSynthesis`
blocks the renderer thread.

This was hit for real during development: `say -v '?'` hung at the shell, and
every browser froze on the first agent line. Nothing in JavaScript can time out
a synchronous platform call, so there is no fix here, only two mitigations that
are already in place:

- `speechSynthesis` is touched **lazily**, on the first line spoken, never at
  construction — so the page still loads, renders and accepts typed input.
- Every access is inside `try`/`catch`, which covers the throwing case even
  though it cannot cover the hanging one.

The honest statement is that a wedged platform audio stack takes the voice with
it, and the recovery is `sudo killall coreaudiod` or a reboot. It is listed here
rather than left to be rediscovered.

### Muting recognition during playback is gating, not echo cancellation

`getUserMedia` is requested with `echoCancellation: true` and
`noiseSuppression: true`, which does the acoustic half of the job. The other
half is gating: `input.setMuted(true)` at the top of every turn,
`setMuted(false)` after the agent finishes, plus `LISTENING.playbackMuteTailMs`
= 250 ms of tail so the last syllable of the agent's own voice does not arrive
as a visitor turn. That is a policy, not a filter. A room with enough reflection,
or a speaker loud enough to be picked up outside the tail, will still produce
self-transcription. Browser echo cancellation is doing the work that matters and
its quality varies by browser and by device.

### Aborting a request stops our work, not the provider's spend

Barge-in aborts the in-flight `/chat` and `/speak` requests, and
[`worker/src/chat.ts`](../worker/src/chat.ts) forwards the abort upstream so the
provider call is genuinely cancelled rather than merely abandoned. The comment
beside it is the honest limit: *"this stops our work and closes the stream.
Tokens the provider has already generated are already spent, and no client-side
abort can un-spend them."* An interrupted turn still consumes free-tier
allowance for whatever was produced before the abort landed.

### Hosted recognition has no interim results

[`src/speech/asr/hosted.ts`](../src/speech/asr/hosted.ts) records a clip,
uploads it and transcribes it, so the words appear all at once rather than
building live as they do in Chrome. The interface shows a quiet "…" instead of a
growing sentence. The latency is also materially worse — upload plus
transcription lands well above the Web Speech path — and this is the rung
Firefox and iOS Safari visitors get by default. Endpointing on this path is
driven by microphone energy rather than by transcript activity, because there
are no interim transcripts to drive it.

The audio also leaves the device. In Chrome the browser already sends it to
Google; here it goes to the gateway and on to the recognition provider. The page
says so before the microphone is first used.

### The daily counter undercounts across isolates

Covered in §4 and repeated here because it belongs in a list of known
imperfections rather than only in a section about cost. The number in KV is a
lower bound on the day's real usage. It is not a ledger, it is a throttle with a
conservative setpoint.

### Two unimplemented visible states

F10's "small note in the diary" and F11's "tap to enable sound" prompt are both
specified in plan §7.5 and neither exists. Both failures degrade correctly and
silently; what is missing is the line of text that would tell the visitor why
something is different. Listed here so that a reader comparing the plan to the
code finds the gap in this document first.

---

## Related

- [`docs/latency.md`](latency.md) — where the milliseconds go, and what has been
  measured
- [`docs/ai-boundary.md`](ai-boundary.md) — why the model cannot commit a booking
- [`docs/planning/project_plan.md`](planning/project_plan.md) — §7.5, §11, §21,
  §22
