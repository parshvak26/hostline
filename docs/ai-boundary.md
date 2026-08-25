# The AI boundary

> **The claim:** the model can propose anything it likes, and it cannot cause a
> booking the engine does not independently agree with.
>
> **The evidence:** [`tests/unit/adversarial.test.ts`](../tests/unit/adversarial.test.ts)
> — 26 tests covering all fourteen cases from the plan, run on every push.

This document explains how that is enforced, and — just as importantly — what it
does *not* cover.

---

## Why bother

A restaurant booking has a property most LLM demos do not: **a wrong answer is a
real failure.** If a chatbot invents a fact, someone reads a wrong sentence. If a
booking agent invents a table, someone drives across town to a restaurant that
has no room for them.

Language models are excellent at understanding "half seven, four of us, maybe
five" and terrible at being reliably right about anything. So the two jobs are
given to two different things:

- The **model** understands people and sounds human.
- The **engine** — ordinary, dependency-free TypeScript — decides what is true.

That split only means anything if it is enforced by structure. "We told the model
not to" is not enforcement.

---

## How it is enforced

### 1. The model has no write path

The model's entire vocabulary is five tools
([`src/agent/brains/tools.ts`](../src/agent/brains/tools.ts)):

| Tool | What it can do |
|---|---|
| `propose_slots` | Suggest values for date, time, party size, name, phone |
| `check_availability` | **Ask** whether a table is free |
| `request_confirmation` | Ask for the booking to be read back |
| `commit_booking` | **Ask** for the booking to be made |
| `escalate` | End the conversation politely |

Note what `commit_booking` takes: **no arguments at all.**

```ts
{
  name: 'commit_booking',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
}
```

That is not an oversight. There is nowhere for the model to put a date, a time,
or a party size, because the engine does not read them from the call — it reads
them from its own state. A model that hallucinates a complete, confident,
perfectly formatted booking has no way to express it.

### 2. `commit_booking` re-derives every precondition

When the request arrives, [`src/engine/machine.ts`](../src/engine/machine.ts)
checks, from its own state and nothing else:

1. Are all five slots filled **and independently validated** by the engine?
2. Is the phase actually `confirming` — has a read-back genuinely been offered?
3. Did **the visitor's own words** classify as agreement?
4. Does the pending draft still match the slots, or has something changed since?
5. Is the table *still* free, checked again, right now?

Fail any one and the call is refused with a typed reason. Nothing about the
refusal depends on what the caller claimed.

### 3. Affirmation is classified by the engine, not reported by the brain

This is the subtle one, and it is where a careless design leaks.

The obvious shape is for the brain to tell the engine "the visitor said yes".
That hands the single most important decision in the system to the component
that is explicitly not trusted. So the engine does not accept that claim. It
receives the visitor's **raw words** and classifies them itself, in
[`src/engine/confirm.ts`](../src/engine/confirm.ts):

```ts
export function classifyAffirmation(text: string): Affirmation
```

Refusal words are checked **before** agreement words, deliberately — "yeah, no"
and "no thanks" both mean no, and the ambiguous cases must fall to the safe
side. For a booking, the safe side is not booking.

The sharpest demonstration of the boundary is
[case 13b](../tests/unit/adversarial.test.ts): the *identical* `commit_booking`
call succeeds or fails depending only on what the visitor said. If the model's
request decided anything, both halves would end the same way.

### 4. Model output is parsed as hostile input

Every tool argument goes through
[`src/engine/validate.ts`](../src/engine/validate.ts), which:

- **never throws** — every failure is a typed `Rejection`, because a validator
  that throws on hostile input can be used to blank the page;
- **validates fields independently** — a proposal with a good date and a
  5,000-character name keeps the date and rejects only the name;
- **checks length before anything touches a regex**, so a five-thousand
  character "name" costs one comparison rather than a regex pass.

Arguments arriving as a raw JSON *string* rather than an object — which models
do — are rejected as `malformed_arguments` rather than crashing. The gateway
client forwards malformed arguments **verbatim** rather than repairing them,
precisely so this path stays exercised.

### 5. The engine cannot reach anything

`src/engine/` has no network, no DOM, no storage, and no clock. That is enforced
by ESLint, not by convention — see the `no-restricted-globals`,
`no-restricted-properties` and `no-restricted-syntax` blocks in
[`eslint.config.js`](../eslint.config.js), and
[`tests/unit/lint-rules.test.ts`](../tests/unit/lint-rules.test.ts), which feeds
deliberate violations through the linter and asserts each one is caught.

It also imports nothing outside itself — no packages, no sibling directories.
That constraint is why 98% statement coverage of the engine is practical rather
than aspirational.

---

## The fourteen cases

Each constructs a tool call **exactly as a model would emit it** — same shape,
same entry point, no test-only back door — and asserts both the specific
rejection reason and that **no booking exists afterwards**.

| # | The attempt | Refused with |
|---|---|---|
| 1 | `commit_booking` with slots incomplete | `slots_incomplete` |
| 2 | `commit_booking` with no confirmation turn | `confirmation_not_affirmative` |
| 3 | `commit_booking` after the visitor said no | `confirmation_not_affirmative` |
| 4 | `propose_slots` with a date in the past | `date_in_past` |
| 5 | `propose_slots` with `partySize: 40` | `party_too_large` |
| 6 | `propose_slots` with a time outside opening hours | `time_outside_hours` |
| 7 | `propose_slots` on a closure date | `date_closure` |
| 8 | `propose_slots` for a slot the engine knows is full | `no_availability` |
| 9 | `propose_slots` with a malformed phone number | `phone_too_short` |
| 10 | `propose_slots` with a 5,000-character name | `name_too_long` |
| 11 | A tool call with an unknown tool name | `unknown_tool` |
| 12 | Tool arguments as a raw string, not an object | `malformed_arguments` |
| 13 | Visitor prompt injection reaching the engine | `party_too_large` |
| 14 | Two conflicting `propose_slots` in one turn | `conflicting_proposal` |

Plus, beyond the plan's list: committing twice, smuggling a booking through
`commit_booking`'s arguments, committing on an agreement that a later correction
invalidated, sixteen hostile argument shapes asserting nothing throws, and a
check that the whole suite leaves the diary byte-identical.

**If any of these produces a booking, the build fails.**

---

## What this does *not* protect against

Stating the limits is the point of writing this down.

- **It does not make the model accurate.** The model can still mishear a date,
  and the engine will happily validate a perfectly legal wrong date. The
  read-back exists for that, and it is the visitor who catches it, not the code.

- **Affirmation classification is lexical.** `classifyAffirmation` matches words
  on boundaries; it has no idea what a sentence means. A visitor who says
  something containing "yes" while meaning no can confirm a booking they did not
  intend. This is a real gap. It is mitigated by refusal-first ordering and by
  the read-back being read aloud, and it is not closed.

- **It does not protect the provider's tokens.** Aborting a request stops our
  work and closes the stream. Whether the provider has already generated and
  billed tokens is not something a client can control.

- **It says nothing about the rule brain being *good*.** The rule brain is
  subject to exactly the same boundary — it also only proposes — but its parsers
  are heuristics and they will occasionally misread a sentence. See the
  limitations in the README.

- **The gateway's quota counters are approximate by design.** They are coalesced
  to fit Cloudflare's free KV write budget. The real cost guarantee is
  structural: no paid plan exists on any account. See
  [`degradation.md`](degradation.md).

---

## Reading the evidence yourself

```bash
npx vitest run tests/unit/adversarial.test.ts
```

Then break it on purpose. In `src/engine/machine.ts`, find `commitBooking` and
delete the `lastAffirmation !== 'yes'` check. Re-run. Cases 2, 3 and 13b go red
immediately.

That is the test worth doing, because a safety suite you have never watched fail
is a safety suite you have no reason to believe.
