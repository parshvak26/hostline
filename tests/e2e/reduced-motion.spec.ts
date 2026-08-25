/**
 * `prefers-reduced-motion: reduce` — nothing moves, and nothing is lost.
 *
 * The listening indicator is the one component that animates every frame while
 * the microphone is open, so "reduced motion" has to mean it stops scheduling
 * frames at all rather than drawing the same thing more slowly. That is checked
 * by counting `requestAnimationFrame` calls from the first line of script.
 *
 * The state still has to be legible without the motion, so the text status and
 * the slot markers are asserted alongside.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  countAnimationFrames,
  gotoApp,
  grantMicrophone,
  seededFriday,
  slotRow,
  slotValue,
  startConversation,
  stubSpeechRecognition,
  talkButton,
  typeTurn,
} from './helpers.js';

// `reducedMotion` is not a first-class test option in Playwright 1.49, so it is
// passed through to the context. Each test confirms the preference actually
// took before asserting anything about the effect of it.
test.use({ contextOptions: { reducedMotion: 'reduce' } });

async function expectReducedMotion(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    'the reduced-motion preference did not take',
  ).toBe(true);
}

test('schedules no animation frames while listening', async ({ page, context }) => {
  await grantMicrophone(context);
  await countAnimationFrames(page);
  await stubSpeechRecognition(page);

  await gotoApp(page);
  await expectReducedMotion(page);
  await startConversation(page);

  await expect(talkButton(page)).toHaveAttribute('data-state', 'listening');
  const indicator = page.locator('.listening-indicator');
  await expect(indicator).toHaveAttribute('data-active', 'true');
  await expect(indicator).toHaveAttribute('data-state', 'listening');

  // The state is still announced in words — the visitor loses the animation,
  // not the information.
  await expect(page.locator('.listening-indicator__status')).toHaveText('Listening');

  expect(await page.evaluate(() => window.__rafCount ?? -1), 'animation frames scheduled').toBe(0);
});

test('makes slot transitions instant', async ({ page }) => {
  const friday = seededFriday();

  await gotoApp(page);
  await expectReducedMotion(page);
  await page.getByRole('button', { name: 'Rather type?' }).click();
  await typeTurn(page, friday);

  await expect(slotRow(page, 'date')).toHaveAttribute('data-state', 'validated');

  for (const selector of ['.slot-panel__value', '.slot-panel__marker']) {
    const durations = await page.locator(selector).first().evaluate((node) =>
      getComputedStyle(node)
        .transitionDuration.split(',')
        .map((part) => part.trim()),
    );
    expect(durations.length, `${selector} declares no transition`).toBeGreaterThan(0);
    for (const duration of durations) {
      expect(duration, `${selector} still animates`).toBe('0s');
    }
  }

  // And the value it was transitioning to is on screen regardless.
  await expect(slotValue(page, 'date')).not.toHaveText('—');
});

test('does not auto-scroll the transcript', async ({ page }) => {
  const friday = seededFriday();

  await gotoApp(page);
  await expectReducedMotion(page);
  await page.getByRole('button', { name: 'Rather type?' }).click();

  for (const turn of [friday, 'seven pm', 'two of us', 'Karani']) await typeTurn(page, turn);

  // Plan §14: "nothing auto-scrolls". The transcript grows past its own box and
  // stays where the visitor left it.
  const scrollTop = await page.locator('.transcript').evaluate((node) => node.scrollTop);
  expect(scrollTop).toBe(0);
});
