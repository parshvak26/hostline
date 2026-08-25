/**
 * Shared machinery for the end-to-end suite.
 *
 * Three things live here because getting them wrong in one spec and right in
 * another is how a suite stops meaning anything:
 *
 *   - **Dates.** The app's "today" is the date in the restaurant's timezone
 *     (`Asia/Kolkata`), not the machine's. The seeded diary is arranged around
 *     the next Friday *strictly after* that date, so the tests compute it the
 *     same way `src/config/seed.ts` does or they assert against the wrong day.
 *   - **Utterances.** The rule brain is a parser, not a model. The exact
 *     phrasings below are the ones proven to parse; they are deliberately
 *     boring, and the ISO date is spoken on a turn of its own because a bare
 *     "friday" resolves to *today* when the test happens to run on a Friday
 *     while the seeded diary always means the following week.
 *   - **Selectors.** Accessible queries wherever the markup offers one, so a
 *     spec that passes is also evidence the control has a name a screen reader
 *     can use. The two exceptions are commented where they occur.
 */

import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';

/** Matches `timezone` in `src/config/restaurant.json`. */
export const RESTAURANT_TIMEZONE = 'Asia/Kolkata';

/** The reference issued on booking: five characters, no `O/0` or `I/1`. */
export const REFERENCE_PATTERN = /^[A-HJ-NP-Z2-9]{5}$/;

/* ------------------------------------------------------------------ time -- */

/** The restaurant's own calendar date, which is the only one the app uses. */
export function restaurantDate(offsetDays = 0): string {
  const at = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: RESTAURANT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function weekdayIndex(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`not an ISO date: ${iso}`);
  }
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * The Friday the demo is arranged around — `nextFriday()` in `seed.ts`.
 *
 * Strictly after today, which is why a test running on a Friday still targets
 * the seeded week rather than the one the diary knows nothing about.
 */
export function seededFriday(): string {
  for (let ahead = 1; ahead <= 7; ahead += 1) {
    const candidate = restaurantDate(ahead);
    if (weekdayIndex(candidate) === 5) return candidate;
  }
  throw new Error('no Friday within seven days, which is impossible');
}

/** "Friday 28 August" — `formatDateLong` in `src/engine/time.ts`. */
export function formatDateLong(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`not an ISO date: ${iso}`);
  }
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${weekdays[weekdayIndex(iso)] ?? ''} ${day} ${months[month - 1] ?? ''}`;
}

/* ------------------------------------------------------------- selectors -- */

/**
 * The Talk button.
 *
 * Queried by id rather than by role, because its accessible name changes with
 * every state ("Talk to us" → "Listening, press to stop" → "Tap to interrupt")
 * and a helper that has to know the state before it can find the button is no
 * helper at all. The id is a contract with `index.html`; the names are asserted
 * directly in `a11y.spec.ts` and `barge-in.spec.ts`.
 */
export function talkButton(page: Page): Locator {
  return page.locator('#talk');
}

export function typeField(page: Page): Locator {
  return page.getByLabel('Type your reply');
}

export function transcript(page: Page): Locator {
  return page.getByRole('log', { name: 'Conversation transcript' });
}

/** Every turn on screen, in order. The class is the only handle on a turn. */
export function transcriptTurns(page: Page): Locator {
  return page.locator('.transcript__turn');
}

export function agentTurns(page: Page): Locator {
  return page.locator('.transcript__turn--agent');
}

export function visitorTurns(page: Page): Locator {
  return page.locator('.transcript__turn--visitor:not(.transcript__turn--interim)');
}

export function slotRow(page: Page, slot: 'date' | 'time' | 'partySize' | 'name' | 'phone'): Locator {
  return page.locator(`.slot-panel__row[data-slot="${slot}"]`);
}

export function slotValue(page: Page, slot: 'date' | 'time' | 'partySize' | 'name' | 'phone'): Locator {
  return slotRow(page, slot).locator('.slot-panel__value');
}

export function confirmationCard(page: Page): Locator {
  return page.locator('.confirmation');
}

/** The reference block, which is a labelled group so it can be read back. */
export function referenceBlock(page: Page): Locator {
  return page.getByRole('group', { name: 'Reference' });
}

export function modeTag(page: Page): Locator {
  return page.locator('.mode-tag');
}

export function diarySection(page: Page): Locator {
  return page.locator('#diary');
}

export function diaryRows(page: Page): Locator {
  return page.locator('.diary-table__row');
}

/**
 * The scrollable table region.
 *
 * Not `getByRole('region', { name: 'The diary' })`: the section around it takes
 * its accessible name from the same words, so the role query is ambiguous —
 * which is itself the `landmark-unique` finding `a11y.spec.ts` prints.
 */
export function diaryScroller(page: Page): Locator {
  return page.locator('.diary-table__scroll');
}

export function fallbackPanel(page: Page): Locator {
  return page.locator('#fallback');
}

/* ------------------------------------------------------------------ boot -- */

/**
 * Load the app and wait until it has finished starting.
 *
 * Readiness is the Talk button settling back to `idle`: the orchestrator warms
 * the speech path first and parks the button on `warming` while it does, so
 * anything asserted before that can be asserting a half-built page.
 */
export async function gotoApp(page: Page): Promise<void> {
  await page.goto('./');
  await expect(page.locator('.conversation__layout')).toBeAttached();
  await expect(talkButton(page)).toHaveAttribute('data-state', 'idle');
}

/** Press Talk and wait for the conversation to be on screen and greeted. */
export async function startConversation(page: Page): Promise<void> {
  await talkButton(page).click();
  await expect(page.locator('#conversation')).toBeVisible();
  await expect(transcript(page)).toBeVisible();
  await expect(agentTurns(page).first()).toContainText('Ember and Oak');
}

/**
 * Reveal the conversation through "Rather type?" — the path a visitor takes
 * when they never intend to use the microphone at all (R-08).
 */
export async function startTyping(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Rather type?' }).click();
  await expect(page.locator('#conversation')).toBeVisible();
  await expect(typeField(page)).toBeVisible();
}

/* ------------------------------------------------------------------ turns -- */

/**
 * Submit one typed turn and wait for the agent to answer it.
 *
 * `Enter` rather than a click on Send: it is the keyboard path, and on a narrow
 * viewport the Talk button is a fixed bar that can sit over the Send button.
 */
export async function typeTurn(page: Page, text: string): Promise<void> {
  const before = await transcriptTurns(page).count();
  const field = typeField(page);
  await field.fill(text);
  await field.press('Enter');

  await expect.poll(() => transcriptTurns(page).count()).toBeGreaterThan(before + 1);
  await expect(transcriptTurns(page).last()).toHaveClass(/transcript__turn--agent/);
}

/** Say every turn in order, by typing. */
export async function bookByTyping(page: Page, turns: readonly string[]): Promise<void> {
  for (const turn of turns) await typeTurn(page, turn);
}

/**
 * The shortest booking the seeded diary allows.
 *
 * A party of two at 19:00 on the seeded Friday: the two-tops are deliberately
 * left free, so this succeeds where the same request for four does not.
 */
export function turnsForPartyOfTwo(friday: string): readonly string[] {
  return [friday, 'seven pm', 'two of us', 'Karani', '9820011447', 'yes please'];
}

/**
 * The demo moment: four people at 19:00 is refused, and the second time is one
 * of the three the engine offered.
 */
export function turnsForPartyOfFour(friday: string): readonly string[] {
  return [friday, 'seven pm', 'four of us', 'quarter past eight', 'Karani', '9820011447', 'yes please'];
}

/* ------------------------------------------------------------ assertions -- */

/** Every slot filled, checked and confirmed, with a reference on screen. */
export async function expectBooked(page: Page): Promise<string> {
  await expect(confirmationCard(page)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your table is booked' })).toBeVisible();

  const reference = (await page.locator('.confirmation__reference').textContent()) ?? '';
  expect(reference).toMatch(REFERENCE_PATTERN);

  // The same code, spelled out, is what a screen reader gets: the card is the
  // one screen someone might read down a phone line.
  await expect(referenceBlock(page)).toContainText(reference.split('').join(' '));
  return reference;
}

/* ------------------------------------------------------------- diagnostics -- */

export interface PageProblems {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly failedRequests: string[];
}

/**
 * Assets the app probes for and is designed to live without.
 *
 * The baked-audio manifest and the demo recording are optional in every build:
 * `PrebakedSpeech` falls through to another voice when the manifest is missing,
 * and the fallback panel drops its `<figure>` when the recording will not load.
 * Neither is shipped in this build, so their absence is the expected state
 * rather than a broken path — everything else is required and is asserted.
 */
const OPTIONAL_ASSET_PATHS = ['/audio/', '/demo/'];

function isOptionalAsset(url: string): boolean {
  return OPTIONAL_ASSET_PATHS.some((path) => url.includes(path));
}

/** Start recording console errors and failed requests. Call before `goto`. */
export function watchForProblems(page: Page): PageProblems {
  const problems: PageProblems = { consoleErrors: [], pageErrors: [], failedRequests: [] };

  page.on('console', (message) => {
    if (message.type() === 'error') problems.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    problems.pageErrors.push(error.message);
  });
  page.on('requestfailed', (request) => {
    if (isOptionalAsset(request.url())) return;
    problems.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'failed'}`);
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    if (isOptionalAsset(response.url())) return;
    problems.failedRequests.push(`${response.url()} — HTTP ${String(response.status())}`);
  });

  return problems;
}

/**
 * Wait until nothing on the page is mid-transition.
 *
 * Needed before a contrast scan: a marker caught halfway through fading in is
 * measured against a blended background, which reports a colour nobody ever
 * sees. Waiting on the animations themselves rather than on a duration keeps
 * this honest if the durations change.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length))
    .toBe(0);
}

/* ------------------------------------------------------------- keyboard -- */

/**
 * Tab until `target` holds focus.
 *
 * Written as a search rather than a fixed number of presses so the test asserts
 * "reachable by keyboard", which is the actual requirement, instead of pinning
 * a tab order that is allowed to change.
 */
export async function tabTo(page: Page, target: Locator, maxPresses = 25): Promise<void> {
  for (let press = 0; press < maxPresses; press += 1) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/* ------------------------------------------------------ storage isolation -- */

/**
 * Wipe the origin's IndexedDB, so the next load is a first visit again.
 *
 * No spec calls this today, and that is the point worth recording: Playwright
 * gives every test its own browser context, so the diary a test writes cannot
 * reach the next one. `diary.spec.ts` reseeds through the app's own "Clear demo
 * data" and a reload instead, which is the behaviour under test rather than a
 * shortcut around it. Keep this for any test that has to reset mid-run.
 */
export async function clearStoredBookings(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase('hostline');
        request.onsuccess = (): void => resolve();
        request.onerror = (): void => resolve();
        request.onblocked = (): void => resolve();
      }),
  );
}

/* ---------------------------------------------------------- permissions -- */

/**
 * Grant the microphone where the browser lets Playwright grant it.
 *
 * Firefox has no permission override, and raises rather than ignoring the
 * request. The spoken tests drive a stubbed recognition API that never opens a
 * device, so the grant is there to prove the app does not need a *denied*
 * microphone to work — not because anything is listening.
 */
export async function grantMicrophone(context: BrowserContext): Promise<void> {
  try {
    await context.grantPermissions(['microphone']);
  } catch {
    // Unsupported in this browser; see above.
  }
}

/* -------------------------------------------------------------- ASR stub -- */

declare global {
  interface Window {
    /** Installed by {@link stubSpeechRecognition}. Returns false if nothing is listening. */
    __emitTranscript?: (text: string, isFinal: boolean) => boolean;
    /** Handle for the interim-holding interval, so a test can stop it. */
    __interimHold?: ReturnType<typeof setInterval>;
    /** Installed by {@link countAnimationFrames}. */
    __rafCount?: number;
    /** Installed by {@link instrumentBargeIn}. */
    __bargeIn?: { pressedAt: number | null; leftSpeakingAt: number | null; resumed: boolean };
  }
}

/**
 * Install a fake `SpeechRecognition` before the app loads.
 *
 * A headless browser has no microphone, so the spoken path cannot be driven by
 * speaking at it. What can be driven is the API the app actually consumes: this
 * is the same shape `src/speech/asr/webspeech.ts` reads, and nothing else about
 * the app is mocked — the endpointer, the orchestrator, the engine and the
 * repository all run for real.
 */
export async function stubSpeechRecognition(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Listening {
      onresult: ((event: unknown) => void) | null;
      onerror: ((event: unknown) => void) | null;
      onend: (() => void) | null;
      started: boolean;
    }

    const instances: Listening[] = [];

    class FakeSpeechRecognition implements Listening {
      continuous = false;
      interimResults = false;
      lang = '';
      maxAlternatives = 1;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      started = false;

      constructor() {
        instances.push(this);
      }

      start(): void {
        if (this.started) throw new Error('recognition already started');
        this.started = true;
      }

      stop(): void {
        if (!this.started) return;
        this.started = false;
        this.onend?.();
      }

      abort(): void {
        this.stop();
      }
    }

    const scope = window as unknown as Record<string, unknown>;
    scope['SpeechRecognition'] = FakeSpeechRecognition;
    scope['webkitSpeechRecognition'] = FakeSpeechRecognition;

    window.__emitTranscript = (text: string, isFinal: boolean): boolean => {
      const live = instances.filter((instance) => instance.started);
      const target = live[live.length - 1] ?? instances[instances.length - 1];
      if (target === undefined || target.onresult === null) return false;
      const alternative = { transcript: text, confidence: 0.95 };
      const result = { isFinal, length: 1, 0: alternative };
      target.onresult({ resultIndex: 0, results: { length: 1, 0: result } });
      return true;
    };
  });
}

/**
 * Say one sentence aloud through the stub and wait for it to land.
 *
 * Retried rather than fired once: the orchestrator mutes recognition for a
 * quarter of a second after it finishes speaking, so a result emitted the
 * instant the button says "Listening" is legitimately dropped. Re-emitting is
 * safe because the first one that lands re-mutes synchronously.
 */
export async function sayAloud(page: Page, text: string): Promise<void> {
  const before = await transcriptTurns(page).count();

  await expect(async () => {
    await page.evaluate(
      ([spoken]) => window.__emitTranscript?.(spoken ?? '', true) ?? false,
      [text],
    );
    await expect(visitorTurns(page).filter({ hasText: text }).first()).toBeVisible({ timeout: 750 });
  }).toPass({ timeout: 20_000 });

  await expect.poll(() => transcriptTurns(page).count()).toBeGreaterThan(before + 1);
  await expect(transcriptTurns(page).last()).toHaveClass(/transcript__turn--agent/);
}

/* ------------------------------------------------------- instrumentation -- */

/** Count every `requestAnimationFrame` the page schedules, from first script. */
export async function countAnimationFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__rafCount = 0;
    const original = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      window.__rafCount = (window.__rafCount ?? 0) + 1;
      return original(callback);
    };
  });
}

/**
 * Time the gap between an interrupt and the Talk button leaving `speaking`.
 *
 * Both timestamps are taken inside the page: a round trip to the test runner is
 * of the same order as the 150ms budget being measured, so measuring from out
 * here would be measuring Playwright.
 */
export async function instrumentBargeIn(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state: { pressedAt: number | null; leftSpeakingAt: number | null; resumed: boolean } = {
      pressedAt: null,
      leftSpeakingAt: null,
      resumed: false,
    };
    window.__bargeIn = state;

    const mark = (): void => {
      if (state.pressedAt === null) state.pressedAt = performance.now();
    };
    document.addEventListener('keydown', mark, true);
    document.addEventListener('click', mark, true);
    document.addEventListener('pointerdown', mark, true);

    const button = document.getElementById('talk');
    if (button === null) return;
    new MutationObserver(() => {
      if (state.pressedAt === null) return;
      const speaking = button.dataset['state'] === 'speaking';
      if (state.leftSpeakingAt === null) {
        if (!speaking) state.leftSpeakingAt = performance.now();
        return;
      }
      // Anything after that is the agent picking the interrupted line back up.
      if (speaking) state.resumed = true;
    }).observe(button, { attributes: true, attributeFilter: ['data-state'] });
  });
}

/** Milliseconds from the interrupt to the button leaving `speaking`. */
export async function bargeInLatency(page: Page): Promise<number> {
  return page.evaluate(() => {
    const state = window.__bargeIn;
    if (state === undefined || state.pressedAt === null || state.leftSpeakingAt === null) return -1;
    return state.leftSpeakingAt - state.pressedAt;
  });
}

/** True if the agent went back to speaking after it was interrupted. */
export async function bargeInResumed(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__bargeIn?.resumed ?? false);
}

/**
 * Hold the speech path open so the `speaking` state can be observed.
 *
 * With no gateway and no baked clips the agent resolves a line in microseconds,
 * which is correct but leaves nothing to interrupt. Delaying the manifest the
 * prebaked adapter reaches for stands in for a slow voice — the same code path
 * a visitor on a bad connection takes.
 */
export async function slowDownSpeech(page: Page, delayMs: number): Promise<void> {
  await page.route('**/audio/manifest.json', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not baked' });
  });
}

/* --------------------------------------------------------------- layout -- */

/** The page must never scroll sideways (plan §14). */
export async function expectNoHorizontalScroll(page: Page, stage: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(
    overflow.scrollWidth,
    `${stage}: document scrolls sideways (${String(overflow.scrollWidth)} > ${String(overflow.clientWidth)})`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
  expect(overflow.bodyScrollWidth, `${stage}: body scrolls sideways`).toBeLessThanOrEqual(
    overflow.clientWidth,
  );
}
