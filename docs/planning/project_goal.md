# Project Goal — Hostline

> **Revision 3.** This version replaces v1 and v2 completely. The owner simplified the project: no real phone line, website only, and the top priority is that the experience feels excellent and the page looks like a real business made it — while costing nothing to run.
>
> **Written in plain English on purpose.** The owner is not deep in this technology. Where a technical term is unavoidable it is explained the first time. Section 14 carries the extra precision the implementing AI agent needs.
>
> **Confirmed:** name **Hostline** · licence **MIT** · demo restaurant **Ember & Oak** · website only · warm-restaurant visual direction.

---

## 1. One-Sentence Definition

Hostline is a free, open-source web page where anyone can press one button, speak out loud, and book a restaurant table by having a natural conversation with an AI voice — no app, no signup, no typing, and no cost to the visitor or the owner.

---

## 2. Elevator Pitch

Restaurants take most of their bookings by phone, and they miss a lot of those calls. Hostline is what answering every one of them could look like: you talk, it listens, it asks only the questions it still needs answered, and it books your table.

The whole thing is a single web page hosted free on GitHub Pages. It uses the AI voice and AI brain that browsers and free services already give away, wrapped in an interface designed to look like a real restaurant's website rather than a tech demo.

The engineering point is reliability under free constraints. The AI runs the conversation, but a small piece of ordinary code — not the AI — owns the booking: it checks the tables, validates the details, and is the only thing allowed to write the reservation. And when the free AI hits its daily limit, that same code quietly takes over the conversation too. The demo gets slightly less chatty and stays completely functional. It cannot break, and it cannot generate a bill.

---

## 3. Problem Statement

**Who has the problem.** Owners of small, independent restaurants — one location, twenty to eighty seats, no dedicated reservations desk.

**What happens today.** The phone rings in the middle of service. Someone runs to answer it or nobody does. Bookings go into a paper diary. Calls that arrive after closing hit voicemail.

**Why that isn't good enough.**

- A caller who can't get through simply calls somewhere else. Nothing is recorded, so the owner never learns how much business walked away.
- The phone rings hardest exactly when everyone is busiest, so answering it always costs someone's attention.
- After-hours calls are usually lost for good — most people don't leave voicemails, and most restaurants don't call back.
- Details get misheard. Wrong name, wrong time, wrong number of people.
- The commercial fixes don't fit: booking platforms charge per diner, and AI phone services charge by the minute and can't be inspected or self-hosted.

**Honesty note.** No statistic appears anywhere in this project without a source. The description above is a well-known pattern in small hospitality, not a measured claim.

---

## 4. Vision

Someone clicks a link. A page opens that looks like a nice neighbourhood restaurant made it — cream paper, dark ink, an elegant serif name at the top, plenty of empty space. Nothing flashing, nothing gradient, nothing that looks generated.

There is one obvious thing to do: **Talk to us.**

They press it and say, "hey, do you have a table for four on Friday?" A warm voice answers in about a second — not robotic, not stiff. "Friday the twenty-eighth, four of you — what time were you thinking?"

Halfway through the next sentence they change their mind: "actually, make it five." The voice stops instantly, mid-word, and adjusts without fuss. It reads the details back, checks the phone number digit by digit, and books the table.

Off to one side, the reservation quietly assembles itself as they speak — date, time, guests, name — each line settling into place once it's confirmed.

Then they click through to the restaurant's own view and see their booking sitting in tonight's list, alongside everything that was said.

Nothing was installed. Nothing was signed up for. Nothing was paid.

The feeling to aim for is **calm and unhurried**. It never rushes, never asks twice for something it already has, never talks over the person, and never pretends to have understood when it hasn't.

---

## 5. Target Users

### Primary — the visitor who clicks the link

This is who the product is actually built for.

- Most often a hiring manager, engineer, or interviewer looking at a portfolio. Sometimes a friend, a designer, a potential collaborator.
- Extremely short on time. Realistically gives the page **under two minutes**.
- On a laptop most of the time, on a phone often enough that mobile has to work properly.
- Will test it by being awkward on purpose: mumbling, interrupting, changing their mind, saying something irrelevant.
- Judges two things almost instantly: *does it work,* and *does it sound and look good.*

### Secondary — the restaurant owner (the story the product tells)

- Runs one small restaurant and takes bookings by phone.
- Not technical. Would use a simple screen, not a terminal.
- Never actually uses this demo — but the product only makes sense if their problem is real and clearly told.

### Tertiary — the technical reviewer reading the code

- Opens the repository after the demo impressed them.
- Looking for: is the architecture real or decorative, are there tests, is the README honest.

> The whole project is optimised for the first persona. Any choice that trades a little product realism for a demo that works instantly is the right trade here.

---

## 6. User Jobs and Pain Points

| Who | What they're trying to do | What goes wrong today | How Hostline handles it |
|---|---|---|---|
| Visitor | Understand the project in seconds | Portfolio pages full of claims and no working demo | One button, working in under a minute |
| Visitor | Test whether it's actually good | Voice demos that sound robotic and can't be interrupted | Natural voice, sub-second replies, interruptible mid-sentence |
| Visitor | Trust that something real happened | Demos that just print text | The booking appears in the restaurant's list, with the transcript |
| Visitor | Use it on their phone | Desktop-only demos | Fully responsive and touch-friendly |
| Visitor | Use it without a microphone | Voice-only demos exclude people | Typing works for the entire flow |
| Restaurant owner | Never miss a booking call | Nobody free to pick up | An agent that always answers |
| Restaurant owner | Get details right | Misheard names and times | Every detail read back and confirmed before booking |
| Restaurant owner | Not double-book | Mental arithmetic over a diary | Real table availability checked before confirming |
| Owner of the repo | Keep it running forever, for free | Free tiers expire and demos die | Automatic fallback so the demo works even when the free AI is exhausted |

---

## 7. Core User Journey

### The main journey — a visitor books a table

1. **Arrives** from a README, a resume, or a shared link.
2. **Reads one screen.** The name, one line explaining what this is, one button. While they read, everything needed for speech is quietly getting ready in the background, so there's no wait when they press the button.
3. **Presses "Talk to us"** and allows microphone access.
4. **Speaks naturally.** Their words appear on screen as they talk.
5. **Gets an answer in about a second**, in a natural voice, asking only for what's still missing.
6. **Interrupts it** to test it. The voice stops immediately and adapts.
7. **Watches the booking form itself** — date, guests, time, name, phone — each line confirmed as it's settled.
8. **Hears the confirmation** read back, says yes, and gets a booking reference.
9. **Clicks through to the restaurant's view** and sees their booking in tonight's list, with the full conversation.
10. **Optionally reads "How this works"** — a short, clear explanation of the design, and the link into the code.

**Under 60 seconds to the good part. Free for them, free for the repo owner.**

### The fallback journey — the free AI has run out today

Identical from the visitor's point of view, except the agent's wording is a little more direct and it asks one question at a time. It still understands them, still checks availability, still books the table, still confirms. A small, honest note appears in the corner. **No error, no dead page, no apology screen.**

### The no-microphone journey

A visitor who declines microphone access, or is somewhere quiet, types instead. Exactly the same conversation, exactly the same result. The agent can still speak its replies out loud, or stay silent if they prefer.

---

## 8. Core Value Proposition

**For the visitor:** almost every AI project in a portfolio is a screenshot or a video. This one talks back, immediately, and does something real. That difference is felt in the first five seconds.

**For the story it tells:** it's a believable answer to a real small-business problem, not a toy.

**Against other portfolio projects:** most either don't run at all, or run badly, or quietly died when a free trial expired. This one is designed so that it *cannot* stop working and *cannot* cost money — and that design is itself the most interesting engineering in the project.

---

## 9. MVP Definition

The project is built in four steps. Each one leaves you with something you'd be happy for someone to see.

> **The honest ordering principle:** make it work, then make it feel good, then make it look good, then make it defensible. Skipping step 2 produces a demo that works but feels cheap. Skipping step 3 produces a good demo nobody takes seriously.

### Step 1 — It works

*Goal: a visitor can talk to it and book a table. It looks plain. That's fine for now.*

- Press to talk; speech is recognised in the browser; words appear on screen.
- The AI brain runs the conversation and collects: **date, time, number of guests, name, phone number.**
- The AI understands normal human phrasing — "next Friday", "half seven", "four of us, maybe five", "just me".
- A separate piece of plain code (the **booking engine**) checks real availability against the restaurant's tables, opening hours, seating capacity, and how long a table is held.
- **Hard rule: the AI can suggest details, but only the booking engine may create a booking.** If the AI proposes a time that's full or a date that doesn't exist, the engine refuses. This is enforced in code, not by asking the AI nicely.
- Every booking is read back out loud and confirmed before it's saved.
- Bookings save into the visitor's own browser, so they survive a page refresh.
- The agent speaks its replies out loud.
- Typing works as an alternative to speaking, for the whole flow.

### Step 2 — It's smooth, and it never breaks

*Goal: this is the step that separates "impressive" from "fine". Treat it as a feature, not polish.*

**Smooth**
- Replies begin within about a second of the visitor finishing their sentence.
- The agent starts speaking the first sentence while it's still working out the rest, so there's no long silence.
- **Barge-in:** the visitor can talk over the agent and it stops immediately — within about a sixth of a second — and it also stops thinking about the answer it was giving, so it doesn't resume a stale sentence afterwards.
- It doesn't wait too long to decide someone has stopped talking. A short pause is enough.
- If it ever needs more than a beat to answer, it says something short like "let me check" rather than leaving dead air.
- Everything is warmed up in advance while the visitor is still reading the page.
- It handles hearing its own voice through the speakers without getting confused.

**Never breaks** *(all of the following are requirements, not nice-to-haves)*
- **The tiny key locker.** A small free service in the middle holds the AI password so it's never inside the web page where someone could steal it.
- **Spending ceiling in code.** Limits per visitor, per conversation, and per day. When the daily ceiling is hit, everyone is automatically served by the simple built-in brain. The owner's cost cannot exceed zero by accident.
- **Anti-spam check** before a conversation can start, so a script can't drain the daily allowance.
- **An off switch** the owner can flip to force everyone to simple mode.
- **Full fallback chain, all tested automatically:**

| If this fails | This happens instead |
|---|---|
| Free AI limit reached, or AI is slow/down | Simple built-in brain takes over, conversation continues |
| Nice voice unavailable | The browser's own built-in voice speaks instead |
| Browser can't do speech recognition (e.g. Firefox) | Speech is recognised through the key locker service instead |
| Microphone refused or unavailable | Typing, with the full conversation intact |
| Everything external is down | Typed conversation with the simple brain — still books a table |

- Being awkward on purpose is handled: silence, background noise, gibberish, off-topic questions, changing your mind, giving three details in one breath, and asking for a table for forty people.

### Step 3 — It looks like a real restaurant made it

*Goal: nobody who sees it thinks "AI generated this page".*

- Full visual design: cream and ink, one warm accent, elegant serif headings, generous space, no gradients, no glowing cards, no rounded-everything.
- A calm live indication that it's listening — something crafted, not a stock animation.
- The booking details fill in with small, considered movement rather than popping into place.
- **Restaurant's view:** tonight's bookings as a simple list with times, names, and guest counts, the visitor's new booking marked, plus a link to read the full conversation.
- A short "How this works" section with a clear diagram.
- Works properly on a phone, down to small screens.
- Works entirely by keyboard; readable contrast; screen-reader friendly; respects a visitor's "reduce motion" setting.

### Step 4 — It's credible

*Goal: survive a technical reviewer reading the code, and survive an interview question.*

- README: what it is, a short recording, the diagram, how it works, honest limitations, what leaves your device, cost, licence.
- Tests on the booking engine covering all the awkward phrasings and every availability rule.
- **Adversarial tests proving the AI cannot create an invalid booking** — instruct it to book a full slot, a date in the past, a party of forty, and confirm the engine rejects all of them.
- An automatic test that turns the AI off entirely and confirms a booking can still be completed.
- Automatic checks on speed and accessibility before anything goes live.
- Real measured numbers published — never invented ones.

### Done means all of the following are true

- [ ] A first-time visitor books a table by voice in under 60 seconds, on Chrome, Edge, Safari, and Firefox, on desktop and phone.
- [ ] Replies start in under a second, measured, half the time or better.
- [ ] Interrupting it works reliably.
- [ ] With the AI switched off, a booking still completes — proven by an automatic test.
- [ ] The AI cannot create an invalid booking — proven by adversarial tests.
- [ ] Nothing in the project can cost the owner money.
- [ ] Someone who doesn't know the owner looks at it and assumes a designer was involved.
- [ ] The README is honest about what it can't do.

---

## 10. Post-MVP Features

Useful, deliberately left for later:

1. **Change or cancel a booking by talking to it.** The natural next conversation.
2. **Answering questions** — opening hours, address, parking, whether it's dog-friendly.
3. **When a slot is full, offer the nearest three** and take a waitlist entry.
4. **Email or text confirmation.**
5. **Support for more than one restaurant** — the settings become a folder instead of a file.
6. **Other languages**, starting with Hindi.
7. **A real phone number.** The AI brain and booking engine are deliberately kept separate from the web page, so a phone version can be added later without rewriting them. This is a genuine possibility, not a throwaway line — but it costs real money every month, so it stays out.
8. **A polished replay** — let a visitor replay a sample conversation without using their microphone.

---

## 11. Non-Goals

This project will **not**:

1. **Have a real phone number.** Costs money monthly, invites spam calls, and nobody clicking a portfolio link will dial it.
2. **Cost the owner anything.** No paid hosting, no paid AI plan, no paid database, no paid domain. Free tiers only, with limits enforced in code.
3. **Take payments or deposits.**
4. **Handle food orders.** Menus and prices are a whole separate project.
5. **Support multiple restaurants.** One restaurant, one settings file.
6. **Require an account.** No sign-up, no login, ever.
7. **Claim to be production software.** It's a well-built portfolio project and the README says exactly that.
8. **Let the AI be responsible for correctness.** It never decides availability and never writes a booking.
9. **Depend on the AI being available.** Everything works without it.
10. **Look like a generic AI-generated web page.** This is an explicit, enforced constraint.

---

## 12. Free-First Constraints (how it stays at zero cost)

| Part | What's used | Cost | The catch |
|---|---|---|---|
| Code hosting | GitHub, public | Free | None |
| Website hosting | GitHub Pages | Free | None |
| Automatic checks | GitHub Actions | Free on public repos | None |
| The key locker | Cloudflare Workers, free plan | Free | Daily request allowance; no slow wake-up |
| AI brain | A fast free AI tier (Groq / Cerebras / Google Gemini Flash class) | Free | Daily limit → falls back to simple mode |
| Nice voice | Free hosted text-to-speech tier | Free | Daily limit → falls back to browser voice |
| Speech recognition | The browser's own, built in | Free | Missing in Firefox → recognised via the locker instead |
| Backup recognition | Free hosted tier via the locker | Free | Rate-limited → typing still works |
| Simple brain | Ordinary code in the page | Free | Less conversational, always available |
| Saving bookings | Storage inside the visitor's browser | Free | Bookings are per-visitor, which is correct for a demo |

**Rules the implementing agent must follow:**

- No password or key may ever appear in the code, on the website, or in the automatic checks. They live only in the locker service.
- The web page never holds an AI key.
- Anything loaded from elsewhere on the internet is copied into the project instead, so an outside service going down can't take the demo with it.
- **A hard daily spending ceiling is enforced in code.** Once hit, everyone gets simple mode automatically. Safety comes from the code, not from the owner keeping an eye on it.
- Which AI and voice services to use is decided when the project is built, based on which free tiers are actually good at that moment. They are deliberately easy to swap.
- **If every free service in this project disappeared tomorrow, the demo would still work** — slightly plainer, fully functional, with no code change. This is a design requirement.

---

## 13. Public Demo Strategy

The demo *is* the project. Everything else supports it.

**What's on the page, top to bottom**

1. **The restaurant.** Name, a line of atmosphere, and **Talk to us**. Visible without scrolling. No carousel, no auto-playing anything.
2. **The conversation.** What was said on one side; the booking filling itself in on the other.
3. **The restaurant's view.** Tonight's bookings, with the new one marked, and the transcript.
4. **How this works.** One clear diagram: the AI suggests, the code decides, and here's what happens when the AI is unavailable.
5. **Honest limitations.** In plain sight, not buried in the README.

**The demo restaurant.** *Ember & Oak* ships with believable opening hours, a fixed set of tables, and some bookings already in the diary — so a visitor can genuinely hit "sorry, seven is full, but I could do half past six or eight" without having to engineer it.

**Nothing can leave a visitor stuck.** Every failure has a defined behaviour (see the table in Step 2). There is no combination of circumstances that produces a broken page.

**A recording as insurance.** A short recorded conversation lives in the README and on the page, so even someone with no microphone, no speakers, or a locked-down work laptop can see exactly what it does.

---

## 14. Technical Direction

*Plain-English summary first, then the detail the implementing agent needs.*

### In plain English

There are two thinkers. The **AI** is good at understanding people and sounding human. The **booking engine** is ordinary code that's good at being right. The AI listens and suggests; the booking engine checks and decides. Only the booking engine can actually write a booking down. If the AI ever goes away, the booking engine can run the whole conversation by itself — just less chattily.

Between the website and the AI sits a **tiny locker service** that holds the password and enforces the spending limits.

### Architecture

```
        ┌──────────────────────────────────────┐
        │   AI brain  (understands · phrases)  │
        │   streams its answer · suggests only │
        └──────────────────┬───────────────────┘
                           │  suggests
      ═══════════════ THE LINE ════════════════
                           │  checks · decides · writes
        ┌──────────────────▼───────────────────┐
        │        Booking engine                │
        │   plain code · no AI · fully tested  │
        │   conversation steps · detail checks │
        │   table availability · confirmation  │
        │   ← can run the whole conversation   │
        │      on its own (fallback mode)      │
        └──────────────────┬───────────────────┘
                           │
   ┌────────────┬──────────┼──────────┬─────────────┐
   ▼            ▼          ▼          ▼             ▼
 Listening   Speaking   Storage    AI brain      Clock
   │            │          │          │
Browser      Hosted    Browser    Free AI tier
speech       voice     storage    via locker
   │            │
Hosted       Browser
backup       voice
```

Everything below the line is swappable. That's what makes the fallbacks possible and what would let a phone version be added later without touching the engine.

### The stack

| Part | Choice | Why |
|---|---|---|
| Website | Plain TypeScript, built with Vite | Small, fast, no framework to justify at this size |
| Styling | Hand-written CSS | A framework's defaults are exactly what "vibe coded" looks like |
| Booking engine | TypeScript, no external libraries, no input/output of its own | Pure logic is easy to test exhaustively; that's where correctness lives |
| AI brain | Free fast provider behind a swappable adapter, using tool-calling | Chosen for speed, not benchmark scores. Swappable because free tiers change |
| Locker service | Cloudflare Worker | Free, no slow wake-up, streams data, holds secrets, enforces limits |
| Listening | Browser speech recognition, plus hosted backup via the locker | Free and fast where available; the backup covers Firefox |
| Speaking | Streamed hosted neural voice, with the browser's own voice as backup | Natural-sounding voice is the single biggest factor in whether it feels good |
| Saving bookings | Browser storage (IndexedDB) behind a small interface | No server needed; the interface means a real database could be added later |
| Hosting | GitHub Pages | Free, permanent, no maintenance |
| Tests | Vitest, plus browser tests for the conversation flow | The engine gets exhaustive tests; the flow gets end-to-end ones |
| Automation | GitHub Actions | Free; runs tests, speed and accessibility checks, and publishes the site |

> **Change from earlier versions:** the booking engine was originally going to be written in Python and squeezed into the browser, so it could be shared with a phone server. With the phone dropped, that only added about 7MB to every visit for no benefit. The engine is now written in the same language as the website. If a phone version is ever built, the engine is plain, dependency-free logic and can be ported or run behind a small service.

### Making it feel smooth — specific requirements

Smoothness comes from the pipeline, not from picking a nicer voice.

- **Overlap the work.** As the AI writes its reply, cut it at the first sentence and start speaking that while the rest is still being written.
- **Decide quickly that someone has stopped talking.** Don't wait for the browser's slow final answer; use the live partial text plus a short pause.
- **Warm everything up early** — audio, the connection to the locker, and a primed first request — while the visitor is still reading the page.
- **Play audio as a queue of small pieces** that can be thrown away instantly, never one long clip that has to finish.
- **Interrupting must also cancel the thinking**, not just the sound, or the agent picks up a stale sentence afterwards.
- **Never allow dead air.** If the AI is slow, the booking engine says something short and natural while it waits.
- **Handle the microphone hearing the speakers** using the browser's echo cancellation plus muting recognition during playback — and write down honestly whatever remains imperfect.
- **Show the speed on screen.** A small, quiet readout of how long the last reply took. A number a reviewer can watch beats a number in a README.

### Language and accents

The demo restaurant is in Bandra, Mumbai. Speech recognition supports **both American English and Indian English**, defaulting to whichever matches the visitor's browser, with a visible switch. Indian-English recognition understands Indian accents noticeably better, which matters if the owner demonstrates this in person.

### Decisions worth being able to defend

1. **Why not let the AI do everything?** Because a wrong booking is a real failure. The AI makes it sound human; the code makes it correct. The AI physically cannot write a booking — that's enforced by structure, not by instructions in a prompt — and there are tests that try to make it break the rule and confirm it can't.
2. **Why keep a non-AI version of the conversation?** Because free AI has daily limits. It's the difference between a portfolio link that works in two years and one that doesn't.
3. **Why an edge locker rather than a normal server?** Free, no thirty-second wake-up delay, and the spending limits live in one place.
4. **Why no UI framework?** At this size a framework adds weight and pushes the design towards a generic look. The visual identity is the point.

### Known hard parts the plan must handle

- Getting replies under a second on a free AI tier.
- Interrupting cleanly, including cancelling work already in progress.
- The microphone hearing the agent's own voice.
- Speech recognition behaving differently in Chrome, Safari, and Firefox.
- Keeping the demo genuinely un-abusable without making it annoying to start.

---

## 15. Privacy and Security

**Say this plainly on the page itself, not just in the README.**

**Stays on the visitor's device:** the booking, the transcript, and all the decision-making about tables and availability. Bookings are saved in the visitor's own browser and are never uploaded. The owner has no database and receives nothing.

**Leaves the device:** what the visitor said, as text, goes to the AI provider through the locker; the reply text goes to the voice provider to be spoken. In Firefox, or wherever the browser can't do speech recognition itself, the audio goes through the locker to a recognition service. In Chrome, the browser's own speech recognition sends audio to Google — that's a property of the browser, not of this project, and the page will say so.

**A quiet, private mode is available:** one switch turns off the hosted AI and voice, and everything happens on the device with the simple brain and the browser's built-in voice. The page explains what that trades away.

**The locker service** holds the passwords and nothing else. It does not store conversations. It counts requests for limit enforcement and that's all.

**No accounts, no logins, no tracking cookies.** A visible "clear demo data" button wipes everything.

**In the code:** no keys anywhere, automatic secret scanning, pinned dependencies, and automated dependency updates.

---

## 16. Accessibility and Performance Goals

*Targets to measure and publish — not claims. No number reaches the README until an automatic check produces it.*

### Accessibility

- The entire booking can be completed by typing, with no microphone.
- Everything works by keyboard alone.
- Readable contrast throughout (WCAG AA).
- Screen readers announce what the agent said and each detail as it's confirmed.
- Clear focus outlines; nothing traps keyboard focus.
- Honours "reduce motion", including the listening animation.
- Works down to a 375px-wide phone screen.
- Nothing is communicated by colour alone.

### Speed

| What | Target | Why it matters |
|---|---|---|
| Page appears | under 1.5s | Impatient visitors |
| Page usable | under 3s | They start reading before it's fully ready |
| Ready to listen | under 2s after the page appears | The button must never feel dead |
| Total download, first visit | under 2MB | Fast on a phone, on mobile data |
| **Finish speaking → agent starts replying (AI mode)** | **under 1s half the time, under 1.3s almost always** | Below this it feels like a conversation; above it feels like a machine |
| Same, in simple mode | under 0.4s | The fallback should feel snappier, not broken |
| Interrupting stops the voice | under 0.15s | Must feel instant |
| Automated speed / accessibility scores | 90+ / 95+ | Checked automatically before publishing |
| Booking engine test coverage | 90%+ | This is where correctness lives |

---

## 17. Resume and Portfolio Value

**How to position it: an AI product engineer who ships things that work.**

Being straight about this: dropping the real phone line means this is no longer a telephony-infrastructure project, and it shouldn't be described as one. What it *is* — a real-time voice product that anyone can use in one click and that is engineered so it cannot break or cost money — is a stronger portfolio piece for almost every job you'd apply to, because people can actually experience it.

**What it demonstrates**

*Real-time voice interaction* — streaming speech in and out with overlapping stages, deciding when someone has finished speaking, interrupting cleanly including cancelling in-flight work, and treating response time as a measured budget rather than a hope.

*Working with AI properly* — tool-calling with a structurally enforced boundary so the model can suggest but never commit; adversarial tests proving it; and automatic, invisible degradation when the model is unavailable — an availability property most AI products simply don't have.

*Engineering judgement* — a public AI demo that cannot generate a surprise bill because the ceiling is in the code; a fallback chain with no single point of failure; and a deliberate choice not to use a framework because the visual identity mattered more.

*Design sense* — a page that looks like a real business made it, which is rarer in engineering portfolios than any technical skill listed above.

**One line for a CV**

> **Hostline** — a voice AI restaurant receptionist you can use in one click. A streaming AI brain handles natural conversation while a dependency-free booking engine independently validates availability and is the only component allowed to write a reservation. Sub-second spoken replies, interruptible mid-sentence, and a tested fallback chain that keeps the demo fully functional when every free service it uses is unavailable. Runs free and permanently on GitHub Pages.

---

## 18. Success Criteria

**The project has succeeded when:**

1. Someone clicks the link and books a table by talking, in under a minute, with no signup.
2. **It sounds good.** Someone with no context calls the voice natural rather than robotic.
3. **It looks designed.** Someone assumes a designer was involved.
4. Replies start in under a second, measured and shown on screen.
5. Interrupting it works reliably.
6. With the AI turned off completely, a booking still completes — proven automatically.
7. The AI cannot create an invalid booking — proven by adversarial tests.
8. Nothing in the project can cost the owner money, and the limits are tested.
9. It works on Chrome, Edge, Safari, and Firefox, on desktop and phone.
10. Automated speed and accessibility targets are met and published.
11. The README explains it in two minutes and is honest about the limits.
12. **It still works a year later without anyone touching it.**

**Deliberately not success criteria:** stars, forks, or traffic. Outside the owner's control, and inventing them would be dishonest.

---

## 19. Risks and Assumptions

### Assumptions to accept or reject

| # | Assumption | Why | If wrong |
|---|---|---|---|
| A1 | Name **Hostline**, licence **MIT**, restaurant **Ember & Oak** in Bandra, Mumbai | Confirmed, plus the location from the owner's own preview | All easy to change; they live in one settings file |
| A2 | **No real phone line**, now or in this project | Owner's decision | Would roughly double the work |
| A3 | The booking engine is written in **TypeScript, not Python**, since the phone server is gone | Removes about 7MB from every visit for no lost benefit | Say so and it goes back to Python |
| A4 | Both **American and Indian English** are supported, defaulting to the visitor's browser | The demo restaurant is in Mumbai and the owner may demo in person | Drop to American English only; slightly less accurate for Indian accents |
| A5 | **Cloudflare Workers** is the locker, and the AI and voice providers are chosen when the project is built from whichever free tiers are best then | Free tiers change faster than this document | The design makes swapping cheap on purpose |
| A6 | **The demo is not fully private**, and the page says so plainly | Speech and text go to free AI services | Only avoidable by giving up the AI brain and the natural voice |
| A7 | Bookings are stored **per visitor, in their own browser** | No server, no cost, no privacy exposure | A shared database would need a paid service |
| A8 | The repo is **public from day one** | It's a portfolio project | — |

### What could go wrong

| Risk | How likely | How bad | What's done about it |
|---|---|---|---|
| Someone spams the demo and drains the free allowance | **High** | **High** | Anti-spam check, per-visitor and per-conversation limits, a daily ceiling, an off switch — all built in Step 2 and tested |
| A free tier shrinks or disappears | High | Medium | Swappable providers, plus a fallback that means the demo survives without any code change |
| Under-a-second replies turn out to be unreachable on free tiers | Medium | High | Sentence-by-sentence speaking, quick end-of-speech detection, warmed-up connections, short filler phrases — and publish the real number, not the hoped-for one |
| The microphone hears the agent's own voice | High | Medium | Echo cancellation plus muting during playback; document what remains imperfect |
| Interrupting is harder than expected | Medium | High | Its own tests; nothing else depends on it working |
| The AI suggests something wrong | Certain | Low, because it's handled | The booking engine checks every suggestion; adversarial tests are a release gate |
| The page ends up looking generic anyway | Medium | **High** | Step 3 is a dedicated design step with an explicit "no gradients, no glowing cards, no framework defaults" rule, judged by looking at it, not by a checklist |
| Steps 3 and 4 never happen | Medium | High | Each step is a genuine stopping point, but the honest warning is that stopping after Step 2 leaves a project that works and looks unfinished |
| Scope creeps back towards phone calls and food orders | Medium | High | Section 11 is binding |

### Things depended on

- **Cloudflare Workers** — generous and reliable, but one company. Isolated behind one adapter; if it's down, the demo falls back and keeps working.
- **Free AI and voice tiers** — the most volatile part of the project. Explicitly designed around.
- **Browser speech recognition** — inconsistent between browsers, which is why the hosted backup and typing both exist.

---

## 20. Future Evolution

Ways this could grow without ruining what's good about it:

1. **Change and cancel by voice** — the obvious next conversation.
2. **Answer questions** — hours, address, parking.
3. **Suggest alternatives and take a waitlist** when a slot is full.
4. **Confirmations by email or text.**
5. **More than one restaurant** — the settings file becomes a folder; the engine already doesn't care.
6. **Hindi**, then other languages.
7. **A phone version** — the engine is deliberately plain, self-contained logic, so it can be lifted out and reused. This is the single biggest possible upgrade and the architecture is already ready for it.
8. **Measure the two brains against each other** — run the same set of tricky sentences through both the AI and the simple engine and publish how they compare on accuracy and speed. Cheap to do and a strong thing to have on the page.

Every one of these plugs into something that already exists. None requires starting over — which is the point of keeping the AI and the booking engine separate.

---

## 21. One-Minute Recruiter Explanation

> Small restaurants miss a lot of booking calls. Hostline is what answering all of them could look like — except you don't need a phone. You open a web page, press one button, and talk. It asks when you'd like to come, how many people, and your name, checks whether a table is actually free, reads it back to you, and books it. You can interrupt it mid-sentence and it keeps up.
>
> The design decision I'd point to is that there are two brains. The AI handles understanding people and sounding natural — that's what it's good at. But the AI is only allowed to *suggest*. A separate piece of plain code owns the booking: it checks the tables, validates every detail, and is the only thing that can actually write a reservation. So if the AI invents a table that doesn't exist, the code rejects it. That's enforced by how the system is built, not by asking the AI to behave, and there are tests that deliberately try to break it.
>
> The other thing is that it's free and it can't die. Free AI services have daily limits, so when the limit runs out, that same plain code takes over the conversation. It gets a bit more to-the-point, and it still books your table. There's a hard spending ceiling written into the code, so it can never cost me anything. If every free service it uses vanished tomorrow, the page would still work.
>
> The whole thing is a static site on GitHub Pages, so it'll still be working in two years without me touching it. That was a deliberate goal.

---

## 22. README and Website Wording

### GitHub "About" line (under 120 characters)

> Talk to an AI restaurant receptionist and book a table — in your browser, in one click. Free, no signup, no phone.

### The headline on the page

> **EMBER & OAK**
> *est. 2019 · Bandra*
>
> **Reservations, answered.**

### Short description

> Press one button and talk. Hostline asks when you'd like to come, how many of you there are, and your name — checks whether a table is really free — and books it. No app, no signup, no typing unless you want to.

### The button

> **Talk to us**
> *Interrupt it. Change your mind. It keeps up.*
> [Rather type?] · [What happens to my voice?]

### README bullets

- **Try it right now** — one click, one button, and you're talking to it. Sub-second replies in a natural voice.
- **Interrupt it** — talk over the agent and it stops instantly and adjusts.
- **The AI suggests, the code decides** — a dependency-free booking engine independently validates every detail and is the only thing allowed to write a reservation. Adversarial tests prove the AI can't get around it.
- **It cannot break** — when the free AI runs out, the booking engine runs the conversation itself. Tested automatically.
- **It cannot cost anything** — hard spending ceiling written into the code, plus an off switch.
- **Real availability** — actual tables, opening hours, seating capacity and how long a table is held, not a simple counter.
- **Designed, not generated** — hand-written CSS, no framework, no gradients.
- **Measured, not claimed** — real response times and accessibility scores, published by automatic checks.

### "Why this exists"

> Small restaurants take most of their bookings by phone, and the phone rings hardest exactly when nobody's free to answer it. The commercial fix costs by the minute and can't be inspected.
>
> Hostline is the other version: open, free, and built so that the parts that have to be right — the date, the time, the table — are checked by code rather than generated and hoped for. It's a reference for what a careful AI voice product looks like when it's built by one person to run forever at no cost.

### README sections required

`Try it` · `What it does` · `How it works (the diagram)` · `The AI suggests, the code decides` · `What happens when the free AI runs out` · `Speed, measured` · `Browser support` · `What leaves your device` · **`Limitations`** · `Running it yourself` · `Roadmap` · `Cost` · `Licence`

> `Limitations` and `What leaves your device` are required and must be honest. Including them reads as experienced. Leaving them out reads as the opposite.

---

## STATUS: DISCOVERY COMPLETE
