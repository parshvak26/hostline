# Latency

Where the milliseconds go, which of them have been measured, and which have not.

The rule this document is written under comes from plan §15: **no number reaches
the README until `scripts/measure-latency.ts` or CI has produced it, and every
published figure names the machine and the conditions it was measured on.** A
latency number without those is decoration. Plan §12.5 adds the corollary that
matters more: where a number cannot be measured yet, publish the reason instead
of an estimate.

Accordingly, §3 below contains one measured result and one empty row.

---

## 1. The budget

Plan §12.5 sets the design, stage by stage. t0 — the instant everything is
measured from — is **end of speech**, not the arrival of a final transcript.

| Stage | Target | What buys the saving |
|---|---|---|
| End-of-speech detection | 0 ms; t0 is defined here | Silence after the last *interim* result, not the browser's `final` event. `LISTENING.endpointSilenceMs` = 600 ms in [`src/config/settings.ts`](../src/config/settings.ts) |
| Network to gateway | 30–80 ms | Cloudflare edge; the connection is warmed during the hero read, before the visitor has pressed anything |
| Model time to first token | 150–400 ms | Provider selected by measuring time-to-first-token rather than by benchmark score; a short prompt; output capped at 220 tokens |
| First sentence complete | +80–200 ms | The system prompt enforces a maximum of two sentences, so the first one arrives early |
| Synthesis to first audio | **0 ms on a cache hit**, 200–400 ms on a miss | The prebaked clip cache — §2 below |
| **Total** | **p50 under 1 000 ms, p95 under 1 300 ms** | Plus a filler at 400 ms, so *perceived* latency is capped even when actual latency is not |

Two numbers from the same file bound the tail rather than the median:
`TURN.fillerAfterMs` = 400 ms, and `TURN.brainTimeoutMs` = 2 500 ms, past which
the rule brain finishes the turn instead.

The endpointing threshold deserves its own note, because it is the one number
that can invalidate every other row. If end of speech is detected late, the
whole budget is wrong by that much and no amount of work on the model or the
synthesis recovers it. Chrome's own `final` event can sit for the better part of
a second, so it is used only as a shortcut when it happens to arrive first;
600 ms of silence after the last text-bearing interim is the primary signal.

---

## 2. The two mechanisms that matter

### Prebaked audio — 0 ms of synthesis on a cached turn

Synthesising a line costs 200–400 ms. The agent says "Which day were you
thinking?" in every single conversation, and paying for it every time spends
most of a one-second budget on a sentence that never changes.

So the fixed lines are synthesised **once, at build time**, by
[`scripts/bake-audio.ts`](../scripts/bake-audio.ts), committed as Opus, and
served from the same origin as the page. A cache hit costs zero synthesis and
usually zero network too, because the browser has the file. `PrebakedSpeech` in
[`src/speech/tts/prebaked.ts`](../src/speech/tts/prebaked.ts) fetches the
manifest **after first contentful paint**, never on the critical path — a cache
that delayed the page it exists to speed up would be a poor trade.

**How many lines are bakeable.** Measured, not estimated:

```
$ npx tsx scripts/bake-audio.ts --dry-run
34 bakeable phrase(s):
```

Run on 2026-08-25. The phrase table in
[`src/config/phrases.ts`](../src/config/phrases.ts) holds **39 keys and 48
variants**; `bakeablePhrases()` selects the **34** that contain no placeholder.
The other 14 carry a visitor's name, date, time, party size or reference and can
only be synthesised live. The 34 cover every greeting, every slot question,
every re-prompt, both refusal families, both fillers, the idle prompt and the
deflection — which is to say, most of what the agent says in most conversations.

> Plan §12.5 and §26 both describe this as "the ~25 most common lines". The real
> figure produced by the script is **34**.

**What is not true yet.** `public/audio/` is empty. No clips
have been baked, because baking requires a provider key that this build does not
have. `PrebakedSpeech.warm()` fails silently when the manifest is absent, every
line falls through the cascade, and — with no gateway either — every line today
is spoken by the browser's own `speechSynthesis`. The 0 ms figure is a property
of the design and of the script that implements it; **it is not currently a
property of the deployed artefact.**

### Sentence-level overlap — and why it buys less here than the plan assumed

Plan §12.5 expects the second mechanism to be overlap: cut the model's stream at
the first sentence boundary and start speaking while the rest is still being
generated. The machinery for that is written and tested. **It is deliberately
not on the critical path, and the reason is worth understanding.**

In this architecture the engine emits the line for very nearly every turn, and
the engine's line wins over the model's wording (`chooseSpokenLines` in
[`src/agent/session.ts`](../src/agent/session.ts)). So speaking the model's
tokens as they arrive would mean speaking something that is then superseded a
moment later — the agent talking over itself. The overlap only applies to the
turns where the model's prose *is* the prose spoken, which are rare by design.

What is wired is the useful half: `onFirstToken` cancels the pending filler the
moment the model starts producing, so a fast reply does not get "let me check"
bolted onto the front of it.

The honest consequence: **the prebaked cache above is what carries this budget,
not the overlap.** Trading the model's phrasing for the engine's certainty costs
this particular optimisation, and that is a fair description of the trade rather
than a defect.

Two functions in [`src/agent/orchestrator.ts`](../src/agent/orchestrator.ts)
implement the mechanism, ready for the turns that need it:

- **`createSentenceStream(onSentence)`** accumulates streamed tokens and emits
  each complete sentence as it forms. A burst of tokens containing two sentences
  emits both rather than holding one back. Unit-tested; not currently called
  from the turn loop, for the reason above.
- **`splitSentences(text, minChars)`** splits an already-complete line into
  speakable chunks, and is what `speak()` iterates over. A trailing fragment
  shorter than `SPEECH.minSentenceChars` = 12 characters is folded back into the
  previous chunk, because a two-word sentence synthesised on its own sounds
  clipped and the round trip costs more than it saves. The upper bound is
  `SPEECH.maxSentenceChars` = 240, which is also the gateway's hard cap on one
  `/speak` request.

The boundary regex is `/[.!?](?:\s|$)/` — deliberately requiring whitespace or
end-of-string after the punctuation, so a decimal point or an abbreviation does
not cut a sentence in half.

### The 400 ms filler — why perceived latency is capped

`armFiller()` sets a timer at `TURN.fillerAfterMs` = 400 ms at the top of every
turn. If no audio has started by then, a short prebaked line plays — "Let me
check." or "Bear with me." — alternating, because a filler that repeats is worse
than a pause.

This is the distinction the budget depends on. **Actual latency** is t0 to the
first audible sample of the *answer*. **Perceived latency** is t0 to the first
audible sample of *anything*, and the filler caps it at roughly 400 ms
regardless of what the model is doing. A visitor waiting 2.4 seconds for a slow
model hears "Let me check" at 400 ms and experiences a pause, not a stall. By
the time the 2 500 ms deadline arrives and the rule brain takes the turn over,
the filler has been covering for two of those seconds.

Only the actual number is published. The filler improves the experience; it does
not improve the measurement, and reporting it as though it did would be exactly
the fake number plan §12.5 forbids.

---

## 3. Measured numbers

### Rule brain, end to end

```
$ npm run measure-latency

Hostline — reply latency, rule brain

  measured   2026-08-25T01:59:04.529Z
  on         Apple M5, 10 cores, 32 GB · darwin/arm64 · Node v24.18.0
  corpus     32 conversations, 172 turns

  p50        0.04 ms
  p95        0.1 ms
  mean       0.05 ms
  slowest    0.27 ms

  target     p95 under 400 ms (plan §15) — met
```

**Conditions.** Apple M5, 10 cores, 32 GB, macOS (darwin/arm64), Node v24.18.0,
mains power, no other load. 32 fixture conversations from
[`tests/fixtures/conversations/`](../tests/fixtures/conversations), 172 turns,
replayed in-process. Three fixtures are replayed first as a warm-up pass and
discarded, because the first run pays for module initialisation and JIT warm-up
and reporting that as reply latency would overstate it by an order of magnitude.
A second run six minutes earlier gave p50 0.05 ms, p95 0.09 ms, slowest 0.32 ms,
which is the run-to-run spread at this scale.

**What the number actually says.** It is three to four orders of magnitude below
the 400 ms target, so "target met" is not an interesting statement. The useful
reading is the opposite one: **the rule brain contributes nothing measurable to
the latency budget.** Parsing a date, validating it, checking the diary and
choosing the next line is arithmetic over small in-memory structures. Every
millisecond a visitor actually waits is spent in recognition, the network, the
model and the synthesis — none of which this script touches. That is worth
knowing precisely because it tells you where optimisation would and would not
pay.

### AI path

| | |
|---|---|
| p50 | *not measured* |
| p95 | *not measured* |

**There is no number here, and there will not be one until the gateway is
deployed.** Measuring the AI path requires a deployed Cloudflare Worker and a
provider API key. Neither exists for this build:
[`worker/wrangler.toml`](../worker/wrangler.toml) still carries
`id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"`, no secrets have been set, and
`VITE_GATEWAY_URL` is empty, which is why `hasGateway()` returns `false` and the
site runs the rule brain.

The script says the same thing in its own output rather than leaving a blank:

> The AI path is not measured here: it needs a deployed gateway and a provider
> key. Run this again after deploying the worker to fill it in.

Plan §12.5 is explicit that the honest missing number is preferable to an
estimate, so the row stays empty. Plan §26 adds the corresponding instruction
for the README: *"Substitute the real measured figures once `eval.yml` has run.
Do not publish targets as achievements."*

### Browser-side latency

Also not measured. The orchestrator marks t0 → first audible sample on every
turn (`markFirstAudio()`), keeps the samples, exposes `latencyStats()` returning
p50 and p95, and emits each mark to the on-screen readout in
[`src/ui/components/latency.ts`](../src/ui/components/latency.ts). The
instrumentation is complete and running, and the end-to-end suite exercises the
turn loop across five browser profiles — but **no browser session's marks have
been captured and published**. Doing that honestly means recording real audio
timings from a real machine and naming it, which is the same discipline applied
to the rule-brain numbers above. Until that happens the row stays empty rather
than being filled with the in-process figure, which measures something else
entirely.

---

## 4. What the measurement does and does not include

**Included.** The rule brain, end to end, for each turn: parse the visitor's
words with the hand-written parsers, validate each field independently, check
availability against the diary, reduce the engine state, and choose the next
line to speak. That path needs no network and no key, so the number is real and
reproducible on any machine.

**Excluded, deliberately.**

- **Speech recognition.** Browser-side, and the largest single unknown on the
  hosted-recognition path, where a clip must be recorded and uploaded before
  transcription begins.
- **Speech synthesis and playback.** Browser-side. Measured in the browser by
  the orchestrator's own marks, which feed the on-screen readout — not by this
  script.
- **Network to the gateway, and the model itself.** Not reachable at build time.
- **Anything the browser does at all.** The script runs in Node. It measures the
  part of the system that runs identically everywhere.

Two properties of the harness are worth stating so the number is not read as
more than it is. The clock is fixed (`fixedClock`) and identifiers are
deterministic (`deterministicIds(7)`), so a fixture replays identically every
time. Fixtures marked `knownGap: true` are excluded from the corpus, so the 172
turns are turns the rule brain is expected to handle.

---

## 5. Reproducing it

```bash
npm run measure-latency            # human-readable
npm run measure-latency -- --json  # machine-readable, for CI
```

The script exits non-zero when p95 crosses 400 ms, so it can be used as a gate.
The JSON form carries `measuredAt`, `environment`, the full rule-brain block, and
an explicit `llmBrain: null` alongside `llmNote` explaining the absence — the
absence is data, not a hole to be filled in later by hand.

### Filling in the AI row

1. Create the KV namespace and replace the placeholder id in
   [`worker/wrangler.toml`](../worker/wrangler.toml).
2. Set the secrets: `MODEL_API_KEY`, `TTS_API_KEY`, `STT_API_KEY`,
   `TURNSTILE_SECRET`, `SESSION_SECRET`, each with `wrangler secret put`.
3. `wrangler deploy`, then set the repository variables `VITE_GATEWAY_URL` and
   `VITE_TURNSTILE_SITE_KEY`.
4. Run `npx tsx scripts/bake-audio.ts` so the prebaked cache actually exists,
   and confirm the manifest covers all 34 lines.
5. Dispatch the **Evaluation and latency** workflow,
   [`.github/workflows/eval.yml`](../.github/workflows/eval.yml). It is manual
   only — `workflow_dispatch` — because it needs a key, it spends free-tier
   allowance, and publishing a measured number should be a deliberate act rather
   than a side effect of a merge. It runs `npm run measure-latency -- --json`,
   uploads `latency.json` as an artefact, and appends the run id and runner OS
   so any published figure traces back to a specific CI run.
6. Replace the empty AI row in §3 with what the run printed, including the
   machine, the date and the workflow run id. Do not round, and do not average
   away a bad p95.

Note that a GitHub-hosted runner is a different machine from the one in §3, so
the two rows will not be comparable and should not be presented as though they
were. Each row names its own conditions.

---

## 6. If the target is missed

Plan §12.5 fixes the escalation order in advance, so that the response to a
disappointing measurement is a decision already made rather than a temptation.
In order:

1. **Widen the prebaked cache.** More lines at 0 ms of synthesis. The cheapest
   lever, bounded by the 300 KB audio budget and by how many lines can be
   written without a placeholder.
2. **Switch model provider.** The adapters in
   [`worker/src/providers/`](../worker/src/providers) exist for this. Selection
   is by measured time-to-first-token, not by benchmark score.
3. **Shorten the opening sentence further.** The system prompt already caps
   replies at two sentences; the first one can be made shorter still, since it
   is the only part on the critical path.
4. **Publish the honest number and explain the constraint.** Say what was
   measured, on what, and why the free-tier configuration produces it.

Step four is a legitimate outcome, not a failure to complete steps one to three.

**Never restate a target as an achievement.** "p50 under 1 000 ms" is a design
target that appears in the plan. It becomes a result only when a run of
`measure-latency` or `eval.yml` prints it, on a named machine, on a named date.
Until then it stays in §1 with the rest of the budget, and §3 stays empty where
it is empty.

---

## Related

- [`docs/degradation.md`](degradation.md) — the five rungs, the failure matrix as
  implemented, and what is actually tested
- [`scripts/measure-latency.ts`](../scripts/measure-latency.ts) — the script that
  produced §3
- [`docs/planning/project_plan.md`](planning/project_plan.md) — §12.5, §15
