# Runbook

Plain English, no jargon. Everything you need to run this, put it online, and
switch the AI on.

**Read this first:** the project works *right now*, with no accounts, no keys and
no money. The AI part is optional and makes it nicer. If you never do the
optional part, you still have a working demo you can send to anyone.

---

## Part 0 — What state the project is in

Everything is written and tested on your machine at
`/Users/mac/Desktop/Git/hostline/`. Nothing has been committed to git and
nothing has been uploaded, because you asked for no commits and no pushes.

So the very first thing you'll do is put it on GitHub. Until you do:

- there is **no live website yet**
- the automatic checks haven't run on GitHub yet (they pass locally)

---

## Part 1 — Run it on your own computer (5 minutes, no accounts)

Open the Terminal app and type these, one line at a time, pressing Enter after
each. `cd` just means "go to this folder".

```bash
cd /Users/mac/Desktop/Git/hostline
npm ci
```

`npm ci` downloads the tools the project needs. It takes a minute or two. You
only do it once.

### Talk to it in the terminal (no browser, no microphone)

```bash
npm run converse
```

Type a sentence like `table for four on friday` and press Enter. Keep answering
its questions. It will book you a table. Type `/quit` to stop.

To watch a scripted conversation run by itself:

```bash
npm run converse -- --demo
```

### Open it as a real web page

```bash
npm run dev
```

It will print a web address like `http://localhost:5173/hostline/`. Hold ⌘ and
click it, or paste it into Chrome. Press **Talk to us** and allow the microphone
when the browser asks.

Press `Ctrl` and `C` together in the Terminal to stop it.

---

## Part 2 — Run the tests

```bash
npm test
```

That runs every test. You should see a line saying all tests passed.

Other useful ones:

| Command | What it checks |
|---|---|
| `npm test` | Everything, quickly |
| `npm run test:unit` | Same, plus a coverage report |
| `npm run test:worker` | The little "key locker" service |
| `npm run test:e2e` | Real browsers clicking through the page |
| `npm run lint` | Code style, plus the design rules (no gradients, etc.) |
| `npm run typecheck` | Type errors |
| `npm run build` | Builds the website into a `dist` folder |

The important one is this:

```bash
npx vitest run tests/unit/adversarial.test.ts
```

That's the test suite that proves the AI **cannot** make a booking the rules
don't agree with. It's the heart of the project. If that ever goes red,
something is genuinely wrong — do not ignore it.

---

## Part 3 — Put it on the internet (10 minutes, free, no card)

You need a GitHub account. You have one: `parshvak26`. The GitHub command-line
tool is already signed in on this machine.

**Step 1 — create the repository and upload the code.**

```bash
cd /Users/mac/Desktop/Git/hostline
git init
git add -A
git commit -m "Hostline: voice AI restaurant receptionist"
git branch -M main
gh repo create parshvak26/hostline --public --source=. --remote=origin --push
```

**Step 2 — turn on the website hosting.**

```bash
gh api -X POST repos/parshvak26/hostline/pages -f build_type=workflow
```

Then check it took:

```bash
gh api repos/parshvak26/hostline/pages
```

You want to see `"build_type": "workflow"` in what it prints. If it errors
saying Pages already exists, that's fine — it's already on.

**Step 3 — wait about two minutes**, then open:

**https://parshvak26.github.io/hostline/**

That's your live site. Send that link to anyone.

**Step 4 — make the repository look good.** Optional but worth 60 seconds:

```bash
gh repo edit parshvak26/hostline \
  --description "Talk to an AI restaurant receptionist and book a table — in your browser, in one click. Free, no signup, no phone." \
  --homepage "https://parshvak26.github.io/hostline/" \
  --add-topic voice-ai --add-topic typescript --add-topic cloudflare-workers \
  --add-topic web-speech-api --add-topic github-pages --add-topic accessibility
```

### What works at this point, with no accounts and no keys

- Someone opens the link and presses one button
- They talk; the browser understands them
- The agent replies out loud in the browser's own voice
- It checks real table availability and books the table
- Typing works instead of talking
- Their booking appears in the restaurant's diary

This is the "simple mode" the project is designed around. A small `simple mode`
tag appears in the corner. **Nothing here can cost you money, because nothing
here talks to a paid service.**

---

## Part 4 — Switch the AI on (optional, ~15 minutes, still free)

This makes the conversation more natural and gives it a better voice. It needs
two free accounts. Neither asks for a credit card.

### Step 1 — Get a Groq account (the AI brain and voice)

1. Go to **https://console.groq.com** and sign up. It's free.
2. Find **API Keys** in the menu and click **Create API Key**.
3. Copy the key. It starts with `gsk_`.
4. **Paste it somewhere safe for a moment — you'll use it twice below.**

> **Never put this key in a file inside the project.** Not in the code, not in a
> config file, not in a note. It only ever gets typed into the two commands
> below. There is an automatic check that fails the build if a key ever ends up
> in the code.

### Step 2 — Get a Cloudflare account (the key locker)

1. Go to **https://dash.cloudflare.com/sign-up** and sign up. Free.
2. **Do not add a payment method.** That's the guarantee this can never cost
   you anything — a free account with no card cannot be charged.

Now set up two things inside Cloudflare:

**A storage box** (for the off switch and the daily counter):

```bash
cd /Users/mac/Desktop/Git/hostline/worker
npm install
npx wrangler login
npx wrangler kv namespace create STATE
```

That last command prints an id that looks like `abc123def456...`. Open the file
`worker/wrangler.toml`, find the line that says
`id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"`, and paste your id in place of that
text.

**A bot check** (so a robot can't drain your free allowance):

1. In the Cloudflare dashboard, go to **Turnstile** and click **Add widget**.
2. Domain: `parshvak26.github.io`
3. It gives you two keys: a **site key** (public, safe to share) and a **secret
   key** (private). Copy both.

### Step 3 — Give the locker your keys

```bash
cd /Users/mac/Desktop/Git/hostline/worker
npx wrangler secret put MODEL_API_KEY      # paste your Groq key
npx wrangler secret put TTS_API_KEY        # paste the same Groq key
npx wrangler secret put STT_API_KEY        # paste the same Groq key
npx wrangler secret put TURNSTILE_SECRET   # paste the Turnstile SECRET key
npx wrangler secret put SESSION_SECRET     # type any long random gibberish
```

For the last one, just mash the keyboard for 40 characters or so. It doesn't
need to be memorable.

### Step 4 — Put the locker online

```bash
npx wrangler deploy
```

It prints an address like:

```
https://hostline-gateway.your-name.workers.dev
```

**Copy that address.**

### Step 5 — Point the website at the locker

```bash
cd /Users/mac/Desktop/Git/hostline
gh variable set VITE_GATEWAY_URL --body "https://hostline-gateway.your-name.workers.dev"
gh variable set VITE_TURNSTILE_SITE_KEY --body "your-turnstile-SITE-key"
```

Use the **site** key here, not the secret one. The site key is meant to be
public.

Then rebuild the site:

```bash
gh workflow run deploy-pages.yml
```

Wait two minutes and reload your page. The AI is now on.

### Step 6 — Record the nice voice lines (one command)

This makes the common replies instant instead of taking half a second.

```bash
cd /Users/mac/Desktop/Git/hostline
export GROQ_API_KEY=gsk_your_key_here
npm run bake-audio
```

It will say `34 baked`. Then:

```bash
git add public/audio
git commit -m "Add prebaked audio"
git push
```

That's it. You only ever do this again if you change the agent's wording.

---

## Part 5 — Day-to-day things you might need

### How do I tell whether the AI is on?

Open the page and look in the corner of the conversation panel.

- **No tag** → the AI is on.
- **`simple mode` tag** → the AI is off, and the built-in rules are running the
  conversation. Everything still works.

You can also check the locker directly by opening this in a browser:

```
https://hostline-gateway.your-name.workers.dev/health
```

- `{"mode":"full"}` → AI on
- `{"mode":"degraded","reason":"..."}` → simple mode, and the reason why

### How do I turn the AI off in a hurry?

```bash
cd /Users/mac/Desktop/Git/hostline/worker
npx wrangler kv key put --binding=STATE kill_switch on --remote
```

Everyone drops to simple mode within one minute. Nobody sees an error.

To turn it back on:

```bash
npx wrangler kv key put --binding=STATE kill_switch off --remote
```

### Can this ever cost me money?

No, and not because of the counters — because of this: **you never added a card
to any account.** A free account with no payment method cannot be billed. When a
free allowance runs out, the service simply says no, and the page quietly falls
back to simple mode.

The counters and the bot check exist to keep your free allowance available for
real visitors, not to stop a bill. There is no bill to stop.

### Something looks wrong. What do I do?

Work down this list. Stop when it's fixed.

**The page is blank.**
Almost always the address. It must end in `/hostline/` with the slash. Check
Settings → Pages on GitHub says **Source: GitHub Actions**.

**The page loads but the button does nothing.**
Open the page in Chrome, press F12, click **Console**. If there's a red message
mentioning the microphone, the browser blocked it — click the padlock in the
address bar and allow the microphone.

**It never speaks.**
Your laptop is probably muted. Also, some browsers won't play sound until you
click something — pressing the button counts, so try pressing it again.

**It says "simple mode" and you expected the AI.**
Open the `/health` address above. If it says `kill_switch`, turn the switch off.
If it says `daily_ceiling`, you've used the day's free allowance — it resets
automatically at midnight UTC. If the page can't reach the locker at all, check
that `VITE_GATEWAY_URL` is set correctly with `gh variable list`.

**Nothing works and you want to start over.**
In the diary view there's a **Clear demo data** button. That wipes the browser's
saved bookings and starts fresh. It only affects your own browser.

**The browser tests (`npm run test:e2e`) all time out on the Talk button.**
This is almost always your Mac's audio, not the project. macOS sometimes wedges
its audio service, and when it does, the browser's `new AudioContext()` — the
thing that plays sound — stops responding, so every test that presses the button
waits forever. Fix it with:

```bash
sudo killall coreaudiod
```

It will ask for your password, sound will cut out for a second, and then
everything works again. Rebooting does the same thing. You can confirm this is
the cause before running any tests: if audio is broken system-wide (try playing
anything), that is your answer.

**A test is failing after you changed something.**
Read which test. If it's in `tests/unit/adversarial.test.ts`, do not "fix" the
test — the rules engine has genuinely stopped protecting the booking, and that
is the one thing this project must never allow.

---

## Part 6 — The very short version

```bash
# run it locally
npm ci && npm run dev

# test it
npm test

# put it online
git init && git add -A && git commit -m "first" && git branch -M main
gh repo create parshvak26/hostline --public --source=. --remote=origin --push
gh api -X POST repos/parshvak26/hostline/pages -f build_type=workflow

# later, to switch the AI on
cd worker && npx wrangler login && npx wrangler deploy
gh variable set VITE_GATEWAY_URL --body "https://your-worker-url"
```
