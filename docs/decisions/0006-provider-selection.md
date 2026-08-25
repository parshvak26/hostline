# ADR-0006 — Groq for model, speech and recognition; verification outstanding

**Date:** 2026-08-25
**Status:** Accepted, with an open action
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

Build against Groq, behind the provider adapters in `worker/src/providers/`, and
**leave the verification open**.

The verification was not performed during this build because it requires signing
up for an account, which is the operator's action rather than the builder's. No
measured claim about Groq's free tier appears anywhere in this repository, and no
latency figure attributed to it appears in the README.

## Consequences

- `worker/src/providers/{model,tts,stt}.ts` isolate the provider so that changing
  it is a one-file change per function.
- The site works fully without any of them. With no gateway configured, the rule
  brain and the browser's own voice run the whole conversation, which is the
  behaviour `tests/e2e/no-gateway.spec.ts` proves.
- **Open action for the operator:** after creating a Groq account, confirm the
  current free-tier limits for `llama`-class chat, PlayAI TTS and Whisper
  large-v3-turbo, and record the figures and the date in this file. If the tier
  has moved, switch to the fallback order above and record that instead.
- Until that is done, `docs/latency.md` carries measured rule-mode numbers only,
  and says plainly that the AI-mode numbers are unmeasured.
