# ADR-0006 — Groq for model, speech and recognition; verification outstanding

**Date:** 2026-08-25
**Status:** Accepted. Verified 2026-08-26.
**Requirement:** plan §0, §12.2, T-063/T-064/T-065

## Context

Plan §0 selects Groq for all three hosted AI functions — the language model, text
to speech, and speech recognition — on one account, one key, one place to
revoke. It was chosen for time-to-first-token, which is what buys the sub-second
target in §12.5, rather than for benchmark scores.

Plan §0 also requires that the provider's current free tier be **verified at
build time**, because free tiers change faster than the plan does, and it gives
a fallback order: Cerebras, then Google Gemini Flash for the model; Cloudflare
Workers AI, then Gemini TTS for the voice.

## Decision

Build against Groq, behind the provider adapters in `worker/src/providers/`.

## Verification, 2026-08-26

Performed against a real account, by listing `GET /v1/models` and calling each
candidate. **Two of the three models the plan named no longer exist**, which is
exactly the volatility §0 predicted:

| Function | Plan §0 said | Actually available | Now using |
|---|---|---|---|
| Chat | `llama-3.3-70b-versatile` | gone | **`openai/gpt-oss-20b`** |
| Speech | `playai-tts` | decommissioned 2025-12-31 | **`canopylabs/orpheus-v1-english`** |
| Recognition | `whisper-large-v3-turbo` | still available | unchanged |

The full chat catalogue on the free tier is now `openai/gpt-oss-20b`,
`openai/gpt-oss-120b`, `openai/gpt-oss-safeguard-20b`, `qwen/qwen3.6-27b`,
`qwen/qwen3.8-27b`, `groq/compound`, `groq/compound-mini` and `allam-2-7b`. All
three tested answered a chat completion without error.

**`gpt-oss-20b` is chosen over `120b` deliberately.** Plan §0 picked Groq for
time-to-first-token rather than benchmark scores, and the smaller model is the
faster one. The work here is slot filling with tool calls and two-sentence
replies — the engine owns every fact, so the model is not being asked to be
clever. If it turns out to phrase things poorly, `MODEL_NAME` in
`worker/wrangler.toml` is a one-line change.

**Two things worth knowing about the speech model.** It requires a **one-time
terms acceptance** in the Groq console before it will answer at all — the API
returns `model_terms_required` until someone clicks it, which is a person's
action and not something a script can do. And it documents WAV as its default
format with no mention of Opus, so `scripts/bake-audio.ts` now negotiates the
format rather than assuming, and reports honestly against the 300 KB budget if
it only gets WAV.

## Consequences

- `worker/src/providers/{model,tts,stt}.ts` isolate the provider so that changing
  it is a one-file change per function.
- The site works fully without any of them. With no gateway configured, the rule
  brain and the browser's own voice run the whole conversation, which is the
  behaviour `tests/e2e/no-gateway.spec.ts` proves.
- The adapters did their job: swapping two decommissioned models was three
  string constants and no logic. That is the whole reason `worker/src/providers/`
  exists, and this is the first time it has been tested in anger.
- **The free tier's speech rate limit is 10 requests per minute**, measured by
  hitting it. Baking all 34 lines therefore takes about four minutes, and
  `scripts/bake-audio.ts` paces itself, honours the `retry after` hint on a 429,
  and is resumable so an interrupted run costs nothing to repeat.
- **Orpheus does not return Opus, only WAV** — roughly 4MB for the set against a
  300KB budget. The script transcodes each clip to Opus locally with ffmpeg
  (24kbps mono, `-application voip`), which is a 17x reduction and lands the set
  at **253.4KB**. Without ffmpeg it keeps WAV and the budget check says so
  rather than silently shipping four megabytes.
- `docs/latency.md` carries measured rule-mode numbers only, and says plainly
  that the AI-mode numbers are unmeasured.
- **The lesson for anyone reading this in a year:** the plan named three models
  and two were gone within eight months. Treat every model id in this repository
  as a guess about the present, and `GET /v1/models` as the truth.
