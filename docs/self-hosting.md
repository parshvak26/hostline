# Self-hosting Hostline

This is the developer's guide to forking Hostline, deploying your own gateway
with your own keys, and ending up with a working site at your own GitHub Pages
URL.

It is not the same document as [`RUNBOOK.md`](../RUNBOOK.md). The runbook is
written for the person who owns this repository, in deliberately plain language,
and it assumes the accounts and the repository name already exist. This one
assumes you are a developer starting from a fork, and it says what each command
actually does and what breaks when it goes wrong. Where the two overlap, the
runbook is the gentler read.

Sections 1 and 2 need no accounts of any kind. Everything from section 3 onwards
is optional.

---

## 1. What you get without doing any of this

A complete, working demo. No accounts, no keys, no cost.

```bash
git clone https://github.com/parshvak26/hostline.git
cd hostline
npm ci
npm run dev
```

Node 24 or newer is required (`engines` in [`package.json`](../package.json),
and [`.nvmrc`](../.nvmrc) pins 24). Vite prints an address; because the base path
is `/hostline/`, the address you want is `http://localhost:5173/hostline/`, not
`http://localhost:5173/`.

Press **Talk to us**, allow the microphone, and book a table. What is running:

- the browser's own speech recognition and speech synthesis, so no audio ever
  leaves the machine;
- the deterministic **rule brain** in `src/agent/brains/rule.ts`, which drives
  the whole conversation on its own;
- the booking engine in `src/engine/`, which is the only thing that can decide
  availability or write a booking — see [`ai-boundary.md`](./ai-boundary.md);
- IndexedDB for storage. There is no server.

A small **`simple mode`** tag appears in the corner. That tag is the normal
state of an unconfigured fork, and it is not an error.

There is also a terminal version with no browser or microphone involved:

```bash
npm run converse            # interactive; /quit to exit
npm run converse -- --demo  # a scripted conversation, hands-off
```

And the full check suite:

```bash
npm test           # every unit and integration test
npm run typecheck  # site and worker
npm run lint       # ESLint, Stylelint, and the design rules
npm run build      # type-check, then build into dist/
npm run test:e2e   # Playwright, against the built output
```

**The gateway is optional.** It buys a more natural conversation and a better
voice. It buys nothing else. If you stop reading here you have a complete,
shareable demo that cannot cost you anything, because nothing it touches is a
paid service. That is a reasonable place to stop.

---

## 2. Fork and publish the static site

### 2.1 Change the base path first

> **This is the single most common failure.** A wrong base path deploys
> successfully and then serves a completely blank page, with the only clue being
> 404s for the JS and CSS in the browser console.

GitHub Pages serves a project site from `https://<user>.github.io/<repo>/`. Vite
must be told that prefix at build time. Open [`vite.config.ts`](../vite.config.ts)
and change line 6:

```ts
const base = process.env['VITE_BASE'] ?? '/hostline/';
```

Replace `/hostline/` with `/<your-repo-name>/`, **with both slashes**. If your
fork is called `hostline` you can leave it alone.

Two other places hard-code the same path and will disagree with you if you skip
them:

- [`playwright.config.ts`](../playwright.config.ts) — `baseURL` and the
  `webServer.url` both end in `/hostline/`. The e2e suite runs against the built
  output precisely so a base-path mistake fails a test rather than a deploy, so
  these must match or every e2e test fails.
- `src/config/settings.ts` — `PUBLIC_CONFIG.repositoryUrl`, and the
  `github.com/parshvak26/hostline` links in [`index.html`](../index.html)
  (lines 93, 110, 111 and 127). Cosmetic, but they point your visitors at
  someone else's repository.

The `VITE_BASE` environment variable exists as an override for local previews.
The deploy workflow does not set it, so changing the default in the file is what
actually matters.

### 2.2 Push and enable Pages

```bash
gh repo create <your-user>/<your-repo> --public --source=. --remote=origin --push
gh api -X POST repos/<your-user>/<your-repo>/pages -f build_type=workflow
gh api repos/<your-user>/<your-repo>/pages
```

The second command sets the Pages source to **GitHub Actions**, which is what
[`.github/workflows/deploy-pages.yml`](../.github/workflows/deploy-pages.yml)
requires. The third confirms it: look for `"build_type": "workflow"`. If it
errors saying Pages already exists, it is already on. The same thing is available
in the web UI under **Settings → Pages → Build and deployment → Source: GitHub
Actions**.

The workflow runs on every push to `main`. It builds, then runs
[`scripts/check-no-secrets.mjs`](../scripts/check-no-secrets.mjs) over `dist/`
and fails the deploy if anything key-shaped reached the bundle, then publishes.

Give it a couple of minutes and open `https://<your-user>.github.io/<your-repo>/`.
You now have everything from section 1, live, in simple mode.

---

## 3. Deploy your own gateway

The gateway is a Cloudflare Worker in [`worker/`](../worker/). It exists for one
reason: **an API key cannot live in a browser**. It holds the keys, verifies
Turnstile, enforces the quotas and the kill switch, and proxies three streams. It
stores no conversation content.

### 3.1 Create a Cloudflare account and add no card

Sign up at `https://dash.cloudflare.com/sign-up`. The free plan is enough for
everything here.

**Do not add a payment method.** This is not a suggestion about frugality, it is
the cost guarantee. An account with no card on file cannot be billed. When a free
tier runs out the provider returns an error, the client falls back to the rule
brain, and the demo carries on. The quota counters in
[`worker/src/quota.ts`](../worker/src/quota.ts) are there to keep the free
allowance available for real visitors — they are not what stops a bill, because
there is no bill to stop.

### 3.2 Install the worker's dependencies and sign in

```bash
npm --prefix worker install
npx wrangler login
```

`worker/` has its own `package.json` and its own lockfile; the root `npm ci` does
not install it.

### 3.3 Create the KV namespace

```bash
npx wrangler kv namespace create STATE
```

This prints an id. Open [`worker/wrangler.toml`](../worker/wrangler.toml), find:

```toml
[[kv_namespaces]]
binding = "STATE"
id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"
```

and replace the placeholder with your id. The binding name is `STATE` and the
code refers to it by that name (`env.STATE`), so do not rename it.

`STATE` holds exactly two kinds of key, both defined in `worker/src/quota.ts`:

- `kill_switch` — set it to `on` and every visitor drops to simple mode within
  60 seconds, with no redeploy;
- `daily:<YYYY-MM-DD>` and `spend:<session-id>` — the global daily turn counter
  and per-session spend, expiring on their own.

The free KV tier allows roughly 1,000 writes a day, which is why the daily count
is accumulated in the isolate and flushed at most once a minute. That makes it an
approximate undercount by design, and `DAILY_TURN_CEILING` is set conservatively
to absorb it. The per-IP and per-session rate limits use the `SESSION_LIMITER`
and `IP_LIMITER` rate-limiting bindings instead, which cost no KV writes at all.

### 3.4 Create a Turnstile widget

In the Cloudflare dashboard, find **Turnstile** and add a widget. Set its domain
to your Pages host — `<your-user>.github.io`, the hostname only, no path. Saving
it gives you two values:

- a **site key**, which is public and belongs in the browser bundle;
- a **secret key**, which is private and belongs only in `wrangler secret put`.

Keep them straight. Swapping them is a common and confusing failure, covered in
section 9.

Turnstile is verified in [`worker/src/session.ts`](../worker/src/session.ts)
before a session token is issued. A verification failure is treated as a failure,
never as a pass: the cost of being strict is one visitor in simple mode, and the
cost of being lenient is an open door onto your free allowance.

### 3.5 Set the five secrets

```bash
cd worker
npx wrangler secret put MODEL_API_KEY      # your model provider key
npx wrangler secret put TTS_API_KEY        # usually the same key
npx wrangler secret put STT_API_KEY        # usually the same key
npx wrangler secret put TURNSTILE_SECRET   # the Turnstile SECRET key
npx wrangler secret put SESSION_SECRET     # any long random string
```

Those five names are exactly the secrets in the `Env` interface in
[`worker/src/types.ts`](../worker/src/types.ts). For `SESSION_SECRET`, any long
random string will do — it only signs the session tokens:

```bash
openssl rand -base64 48
```

> **Never put a secret in a file in this repository.** Not in
> `wrangler.toml`, not in `.env`, not in a comment, not in a note "temporarily".
> `wrangler secret put` is the only place a secret goes. [`.env.example`](../.env.example)
> contains public build-time values only, `.env` and `.env.local` are gitignored,
> `gitleaks` scans the whole history on every push, and
> `scripts/check-no-secrets.mjs` scans the built bundle. All three of those will
> catch you, which is the point, but the habit is the real protection.

### 3.6 Set `ALLOWED_ORIGIN`

In `worker/wrangler.toml`, under `[vars]`:

```toml
ALLOWED_ORIGIN = "https://parshvak26.github.io"
```

Change it to your Pages **origin** — scheme and host, no path, no trailing slash.
For `https://you.github.io/my-fork/` the value is `https://you.github.io`.

This is a CORS allowlist, checked in `worker/src/index.ts`. `http://localhost:5173`,
`http://localhost:4173` and `http://127.0.0.1:5173` are always allowed as well,
so local development against a deployed gateway works.

Be clear about what this buys you: **not much.** Anyone can send any `Origin`
header they like with `curl`, so this stops the gateway being casually embedded
in someone else's page and nothing more. The real controls are the Turnstile
check on `/session`, the per-IP and per-session rate limits, the per-session
quota re-checked server-side on every request, and `DAILY_TURN_CEILING`. The
comment at the top of `worker/src/index.ts` says the same thing.

The other `[vars]` are public configuration you can leave alone: `DAILY_TURN_CEILING`,
`KILL_SWITCH`, `MODEL_NAME`, `TTS_MODEL`, `TTS_VOICE` and `STT_MODEL`.

### 3.7 Deploy

```bash
cd worker
npx wrangler deploy
```

It prints a URL of the form `https://hostline-gateway.<your-subdomain>.workers.dev`.
Copy it.

The name comes from `name = "hostline-gateway"` in `wrangler.toml`; change it
there if you want a different one. From the repository root the equivalent
command, and the one
[`deploy-worker.yml`](../.github/workflows/deploy-worker.yml) uses, is
`npx wrangler deploy --config worker/wrangler.toml`.

### 3.8 Verify

```bash
curl -s https://hostline-gateway.<your-subdomain>.workers.dev/health
```

A healthy gateway returns exactly:

```json
{"mode":"full"}
```

`/health` is unauthenticated and needs no session, deliberately — the client asks
it before deciding whether getting a session is worth it. A degraded gateway
returns `{"mode":"degraded","reason":"kill_switch"}` or `"daily_ceiling"`, which
is a working state, not an error.

Two more checks worth running. That the router and the secrets are wired up:

```bash
curl -s -X POST https://hostline-gateway.<your-subdomain>.workers.dev/session \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://<your-user>.github.io' \
  -d '{}'
```

Expect `{"error":"A Turnstile token is required.",...,"code":"missing_turnstile"...}`.
Reaching that error means CORS accepted your origin and the route exists. And
that CORS actually rejects a stranger:

```bash
curl -s -X POST https://hostline-gateway.<your-subdomain>.workers.dev/session \
  -H 'Origin: https://not-your-site.example' -d '{}'
```

Expect a 403 with `"code":"bad_origin"`.

### 3.9 Optional: deploy the worker from CI

`deploy-worker.yml` redeploys the gateway when anything under `worker/` changes.
It runs the worker test suite first and only then deploys. It needs two
repository **secrets**:

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
```

Your five `wrangler secret put` values are not passed through this workflow and
must never be added to it. They live in Cloudflare.

---

## 4. Point the site at your gateway

Two values, set as repository **variables**:

```bash
gh variable set VITE_GATEWAY_URL --body "https://hostline-gateway.<your-subdomain>.workers.dev"
gh variable set VITE_TURNSTILE_SITE_KEY --body "<your Turnstile SITE key>"
```

Those two names are what `deploy-pages.yml` reads (`${{ vars.VITE_GATEWAY_URL }}`
and `${{ vars.VITE_TURNSTILE_SITE_KEY }}`) and what `src/config/settings.ts`
exposes as `PUBLIC_CONFIG`. In the web UI they live under **Settings → Secrets
and variables → Actions → Variables**.

**Variables, not secrets, and the distinction matters.** A GitHub *secret* is
masked in logs and unreadable after it is set; a *variable* is plain text that
anyone with repository access can read. Both of these values are public by
design and end up in the browser bundle where anyone can read them anyway: a
gateway URL is a URL, and a Turnstile *site* key is meant to be in the page —
that is what makes it the site key rather than the secret key. Putting them in
secrets would be cargo-culting, and would also make CI logs harder to debug for
no benefit.

Setting a variable does not rebuild anything. Trigger a build:

```bash
gh workflow run deploy-pages.yml
```

The gateway URL is also compiled into the page's Content-Security-Policy — the
`csp()` plugin in `vite.config.ts` adds it to `connect-src` and `media-src`, and
adds `https://challenges.cloudflare.com` to `script-src` and `frame-src` once a
Turnstile site key is present. A build with no gateway grants itself no
permission to reach one. This is why setting the variables requires a rebuild
rather than just a reload, and why a gateway URL typo shows up as a CSP
violation in the console rather than a network error.

For local development against your deployed gateway, put the same two values in
`.env.local` (gitignored, and never a secret):

```
VITE_GATEWAY_URL=https://hostline-gateway.<your-subdomain>.workers.dev
VITE_TURNSTILE_SITE_KEY=<your Turnstile SITE key>
```

You can also run the gateway locally with `npm --prefix worker run dev`, which
serves it on `http://localhost:8787`.

---

## 5. Bake the audio

The agent's fixed lines — the greeting, "which day were you thinking?", the
fillers — are said in every conversation and never change. Synthesising each of
them at runtime costs 200–400ms, which is most of the sub-second budget spent on
a sentence that is always identical.

So they are synthesised once, at build time, committed as Opus, and served from
your own origin. A turn served from that cache costs **0ms of synthesis**, and it
removes roughly half the runtime provider calls as a side effect.

```bash
export GROQ_API_KEY=gsk_...
npm run bake-audio
```

There are currently 34 bakeable phrases; see them without a key using
`npx tsx scripts/bake-audio.ts --dry-run`. The script reads `GROQ_API_KEY` or
`TTS_API_KEY` from the environment, writes `public/audio/*.opus` and
`public/audio/manifest.json`, and fails if the total exceeds the 300KB budget.
Only lines with no placeholders are baked — the read-back contains the visitor's
name and is always synthesised live — and `bakeablePhrases()` in
`src/config/phrases.ts` decides which those are, so there is no second list to
keep in step.

Then commit the result:

```bash
git add public/audio && git commit -m "Bake audio" && git push
```

The key is used here, on your machine, and never reaches the browser or the
repository. **The site works fully without any of this.** Until the manifest
exists, every line falls through to hosted or browser speech; the cache is a
speed feature, not a dependency.

---

## 6. Get your own AI provider keys

Groq is the default, chosen for time-to-first-token rather than benchmark scores,
because time-to-first-token is what the latency budget is actually spending. One
account covers all three functions — chat, speech and recognition — which is one
key to rotate and one place to revoke.

Sign up at `https://console.groq.com`, find the API keys section, and create one.
The key is what you paste into `MODEL_API_KEY`, `TTS_API_KEY` and `STT_API_KEY`.

**Free tiers move faster than documentation does.** No measured claim about any
provider's current free tier appears anywhere in this repository, and
[`docs/decisions/0006-provider-selection.md`](./decisions/0006-provider-selection.md)
records that the verification is an open action for whoever operates the deploy.
Check the current limits yourself and write down what you find.

If the tier has moved, the documented fallback order is:

| Function | Default | Fallbacks |
| --- | --- | --- |
| Language model | Groq (Llama class) | Cerebras, then Google Gemini Flash |
| Speech synthesis | Groq PlayAI TTS | Cloudflare Workers AI, then Gemini TTS |
| Recognition | Groq Whisper large-v3-turbo | the same OpenAI-compatible dialect |

The adapters in `worker/src/providers/` exist for exactly this: `model.ts`,
`tts.ts` and `stt.ts` each hold one endpoint and one request body, and nothing
outside them knows the wire format. Swapping a provider is a one-file change per
function. All the fallbacks speak the OpenAI-compatible dialect, so in practice
it is a URL and a key. If you change the TTS provider, change
`scripts/bake-audio.ts` to match, or your baked clips will not sound like your
live ones.

---

## 7. Make it your own restaurant

[`src/config/restaurant.json`](../src/config/restaurant.json) is the **only**
place the restaurant is defined. Every availability decision reads from it.

- `name`, `neighbourhood`, `established` — identity;
- `timezone` — an IANA name, e.g. `Europe/London`. Every time in the file is
  local to this zone;
- `locales` — the first is the default; the site picks the best match for the
  visitor's browser;
- `service` — `slotMinutes`, `leadTimeMinutes`, `horizonDays`, `maxPartySize`,
  `minPartySize`;
- `hours` — one entry per weekday, either `{ "closed": true }` or `windows`, a
  list of `["HH:MM", "HH:MM"]` pairs. Two windows means lunch and dinner;
- `closures` — dated one-off closures with a reason, which the agent will say;
- `tables` — table classes with `seats` and how many of each you have;
- `turnTimeMinutes` — how long a party of each size occupies a table;
- `policy` — `combineTables` and `lastSeatingBeforeCloseMinutes`.

The config is validated once at startup by `validateRestaurantConfig()` in
`src/config/validate.ts`, before anything else runs. A malformed config **fails
loudly** with a `ConfigError` naming the exact field, prefixed `restaurant.json:`
— for example `restaurant.json: hours.tue: an open day needs at least one
window`. This is deliberate: a typo in an opening window would otherwise surface
as a mysterious "we're closed then" three layers away. If your fork shows the
fallback panel immediately on load, read the console; the message will tell you
precisely which field is wrong.

For the agent's **wording**, edit `src/config/phrases.ts`. It holds every fixed
line, keyed by `PhraseKey`, with variants so the agent does not repeat itself.
The house style is binding and worth respecting: warm, brief, competent, never
apologetic, no exclamation marks, at most two sentences per line — the last is a
latency rule as much as a style one, because the first sentence is what reaches
audio first.

**Re-run `npm run bake-audio` after any copy change.** Clips are keyed by a hash
of the text, so a reworded line quietly stops matching its clip and falls back to
live synthesis. `npm run lint:phrases` checks coverage.

---

## 8. Verify your deployment

- [ ] The site loads at `https://<your-user>.github.io/<your-repo>/` and is not
      blank. Open the console and confirm no 404s for JS or CSS.
- [ ] `curl -s https://<your-worker>/health` returns `{"mode":"full"}`.
- [ ] A booking completes end to end and appears in the diary view.
- [ ] The kill switch works:
      `npx wrangler kv key put --binding=STATE kill_switch on --remote`, then
      `/health` returns `{"mode":"degraded","reason":"kill_switch"}` within 60
      seconds and the page shows `simple mode`. Set it back to `off`.
- [ ] No secret in the bundle: `npm run build && node scripts/check-no-secrets.mjs`.
      It must report no secret-shaped values. This also runs in `deploy-pages.yml`
      on every deploy.
- [ ] `npm test` and `npm run test:worker` pass locally.
- [ ] `npm run test:e2e` passes — this is what catches a base-path mistake,
      provided you updated `playwright.config.ts` in section 2.1.

---

## 9. Troubleshooting

**Blank page.** The base path, nine times out of ten. Check `base` in
`vite.config.ts` matches `/<your-repo>/` exactly, both slashes included. Check
the console for 404s on `/assets/...` — if the paths are missing your repository
name, that is the confirmation. Check **Settings → Pages** says the source is
GitHub Actions. And check the URL you opened has the trailing slash.

**CORS refusals.** The browser console says the response failed the
access-control check, or the gateway returns 403 `bad_origin`. `ALLOWED_ORIGIN`
in `wrangler.toml` must be the origin only — `https://you.github.io`, not
`https://you.github.io/my-fork/` and not with a trailing slash. It is a string
comparison, so any difference at all fails. Redeploy the worker after changing
it; a `[vars]` change needs `npx wrangler deploy`, unlike a KV change.

**`/health` returns `degraded`.** Read the `reason`. `kill_switch` means either
the `kill_switch` KV key or the `KILL_SWITCH` var is `on`; the KV key is the live
one and the var needs a redeploy. `daily_ceiling` means `DAILY_TURN_CEILING`
turns have been counted today; it resets at midnight UTC.

**Deploy fails on the KV namespace.** If `wrangler deploy` complains about the
namespace, you almost certainly still have `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` in
`wrangler.toml`. `npx wrangler kv namespace list` will show you the real id.

**Turnstile keys swapped.** The two failures look quite different, which is how
you tell them apart. Site key where the secret belongs: `/session` returns 403
`turnstile_failed` for everyone, because Cloudflare rejects the verification.
Secret key where the site key belongs: the widget itself fails to render in the
browser, and `check-no-secrets.mjs` will fail your build, because the Turnstile
secret key shape is one of the patterns it looks for. If a build fails on that
check, rotate the key rather than just fixing the variable — it has been in a
build log.

**The worker deploys but the site stays in simple mode.** Work down this list:

1. `curl /health` directly. If it is unreachable, the gateway is not deployed
   where you think it is.
2. `gh variable list` — is `VITE_GATEWAY_URL` set, and exactly right?
3. Did you rebuild after setting it? A variable change alone does nothing;
   `gh workflow run deploy-pages.yml`.
4. Look for a CSP violation in the console. If the gateway URL in the built
   page's `connect-src` differs from the one being called, the variable was
   wrong at build time.
5. Is `VITE_TURNSTILE_SITE_KEY` set, and is it the **site** key rather than the
   secret one? The gateway will not issue a session without a Turnstile token,
   and without a session every hosted request is refused with 401 — which the
   client correctly reads as "use the rule brain". A missing or wrong site key
   therefore looks exactly like a broken gateway.
6. Open the browser console and press the Talk button. The Turnstile script is
   loaded on that first press, not on page load. If the request to
   `challenges.cloudflare.com` is blocked — by an extension, or by a `connect-src`
   that was built without the site key present — the token never arrives.

**A test fails after you change something.** Read which one. If it is in
`tests/unit/adversarial.test.ts`, do not adjust the test. That suite proves the
model cannot make a booking the rules disagree with, which is the project's
central claim.

---

## 10. Costs

| Line item | Service | Free tier | Cost |
| --- | --- | --- | --- |
| Source hosting | GitHub, public repository | Unlimited public repos | $0 |
| Web hosting | GitHub Pages | 1GB site, 100GB/month soft bandwidth | $0 |
| CI/CD | GitHub Actions | Unlimited minutes on public repositories | $0 |
| Edge service | Cloudflare Workers | 100k requests/day; ~30 per conversation | $0 |
| Key–value store | Cloudflare KV | 100k reads/day, ~1k writes/day | $0 |
| Bot protection | Cloudflare Turnstile | Unlimited | $0 |
| Language model | Groq or equivalent | Rate-limited free tier | $0 |
| Speech synthesis | Groq PlayAI TTS or equivalent | Rate-limited free tier | $0 |
| Recognition | Web Speech API in the browser | No quota | $0 |
| Hosted recognition fallback | Groq Whisper or equivalent | Rate-limited free tier | $0 |
| Database | IndexedDB in the visitor's browser | n/a — no server storage exists | $0 |
| Fonts | Self-hosted subset | n/a — no third-party font request | $0 |
| Domain | `github.io` subdomain | n/a | $0 |
| Analytics, monitoring, error tracking | None, deliberately | n/a | $0 |

`workers_dev = true` in `wrangler.toml` and the absence of any paid binding are
what keep the worker on the free plan.

**The structural guarantee is not the counters.** It is that no paid plan is
enabled on any account, and no card is on file. When a free tier is exhausted the
provider returns an error, the gateway reports `degraded`, the client switches to
the rule brain and the browser's own voice, and the visitor completes their
booking anyway. Cost cannot exceed zero even if every quota control failed at
once. The counters exist so that your free allowance is spent on visitors rather
than on a script.

---

## What has not been verified

In the interests of not overclaiming: **this document has not been executed end
to end on a clean machine.** Doing so requires Cloudflare, Groq and GitHub
accounts that this build did not have.

Specifically:

- **Verified against the repository.** Every command, script name, binding name,
  secret name, variable name, environment variable, KV key, HTTP response shape
  and file path here was read out of the file it belongs to —
  `package.json`, `worker/package.json`, `worker/wrangler.toml`,
  `worker/src/types.ts`, `worker/src/quota.ts`, `worker/src/session.ts`,
  `worker/src/health.ts`, `worker/src/index.ts`, `vite.config.ts`,
  `playwright.config.ts`, the three workflow files, `.env.example`,
  `src/config/*` and `scripts/*` — rather than recalled.
- **Not verified.** Anything that needs a live account: the Cloudflare and Groq
  sign-up flows and their current dashboard layouts (which is why they are
  described as "find X" rather than "click the third item"), the exact output of
  `wrangler login`, `wrangler kv namespace create` and `wrangler deploy`, the
  real `/health` response from a real deployment, and every free-tier figure in
  section 10, which comes from the project plan's audit rather than from a
  provider's page read today.
- **The session handshake has never run against a real gateway.**
  `src/gateway/turnstile.ts` loads the widget on the first press of the Talk
  button, obtains a token, and `src/main.ts` exchanges it for a session before
  the conversation begins. Every step of that is written and typechecked, and
  every failure path resolves to "no session, use the rule brain" — but no one
  has watched the happy path succeed, because that needs a deployed worker and a
  real Turnstile widget. If you are the first to try it, the `curl` checks in
  3.8 will tell you whether the gateway side is right, and the browser console
  on the first button press will tell you whether the client side is.

If you follow this and something is wrong, an issue saying which step and what
actually happened is genuinely the most useful thing you could send.
