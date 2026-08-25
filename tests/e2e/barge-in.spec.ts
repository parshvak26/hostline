/**
 * Barge-in: the agent stops when it is interrupted, and does not carry on.
 *
 * Two ways in. `Escape` is the one that needs no microphone and no permission,
 * which is why the plan calls it the keyboard equivalent rather than a
 * convenience; pressing the button while it reads "Tap to interrupt" is the one
 * a visitor on a phone uses. Both have the same budget: 150ms (R-22).
 *
 * The measurement is taken inside the page — a round trip to the test runner
 * costs a meaningful fraction of 150ms, and measuring Playwright would prove
 * nothing about the app.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  agentTurns,
  bargeInLatency,
  bargeInResumed,
  gotoApp,
  grantMicrophone,
  instrumentBargeIn,
  slowDownSpeech,
  startConversation,
  stubSpeechRecognition,
  talkButton,
  typeField,
} from './helpers.js';

const STOP_BUDGET_MS = 150;

/**
 * How long the speech path is held open.
 *
 * With no gateway and no baked clips a line resolves in microseconds, which is
 * correct and leaves nothing to interrupt. Delaying the manifest the prebaked
 * adapter reaches for is the same code path a visitor on a bad connection takes.
 */
const SLOW_SPEECH_MS = 2_000;

test.beforeEach(async ({ page, context }) => {
  await grantMicrophone(context);
  await stubSpeechRecognition(page);
  await slowDownSpeech(page, SLOW_SPEECH_MS);
});

/** Get the agent talking, and leave it talking. */
async function startTheAgentSpeaking(page: Page): Promise<string> {
  await gotoApp(page);
  await startConversation(page);

  const field = typeField(page);
  await field.fill('table for two');
  await field.press('Enter');

  await expect(talkButton(page)).toHaveAttribute('data-state', 'speaking');
  return (await agentTurns(page).last().textContent()) ?? '';
}

test('Escape stops the agent inside the budget, and it does not resume', async ({ page }) => {
  const interrupted = await startTheAgentSpeaking(page);
  await instrumentBargeIn(page);
  const spokenLines = await agentTurns(page).count();

  await page.keyboard.press('Escape');

  const button = talkButton(page);
  await expect(button).not.toHaveAttribute('data-state', 'speaking');

  const elapsed = await bargeInLatency(page);
  expect(elapsed, 'no measurement was taken').toBeGreaterThanOrEqual(0);
  expect(elapsed, `stopping took ${String(Math.round(elapsed))}ms`).toBeLessThan(STOP_BUDGET_MS);

  // Not resuming is the harder half. Waiting out the injected delay is the
  // point of this wait: the interrupted line must not come back when the slow
  // speech source finally answers.
  await page.waitForTimeout(SLOW_SPEECH_MS + 500);

  expect(await bargeInResumed(page), 'the agent went back to speaking').toBe(false);
  expect(await agentTurns(page).count(), 'a line was spoken after the interrupt').toBe(spokenLines);
  await expect(agentTurns(page).filter({ hasText: interrupted })).toHaveCount(1);
});

test('pressing the button while it reads "Tap to interrupt" stops it just as fast', async ({
  page,
}) => {
  await startTheAgentSpeaking(page);

  const button = talkButton(page);
  // The label is the instruction; if it did not say this, pressing would start
  // a second conversation instead of stopping the first.
  await expect(button).toHaveText('Tap to interrupt');
  await expect(button).toHaveAccessibleName('Tap to interrupt');

  await instrumentBargeIn(page);
  await button.click();

  await expect(button).not.toHaveAttribute('data-state', 'speaking');

  const elapsed = await bargeInLatency(page);
  expect(elapsed, 'no measurement was taken').toBeGreaterThanOrEqual(0);
  expect(elapsed, `stopping took ${String(Math.round(elapsed))}ms`).toBeLessThan(STOP_BUDGET_MS);

  // Back to listening, not back to the start: the conversation continues.
  await expect(button).toHaveAttribute('data-state', 'listening');
  await expect(page.locator('#conversation')).toBeVisible();

  await page.waitForTimeout(SLOW_SPEECH_MS + 500);
  expect(await bargeInResumed(page), 'the agent went back to speaking').toBe(false);
});
