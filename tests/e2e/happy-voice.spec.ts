/**
 * The spoken path, driven through a stubbed `SpeechRecognition`.
 *
 * A headless browser has no microphone, so the only honest way to exercise this
 * is to feed the API the app actually reads. Everything downstream of that —
 * the endpointer, the orchestrator, the rule brain, the engine, IndexedDB — is
 * the real thing.
 */

import { expect, test } from '@playwright/test';
import {
  agentTurns,
  expectBooked,
  formatDateLong,
  gotoApp,
  grantMicrophone,
  sayAloud,
  seededFriday,
  slotValue,
  startConversation,
  stubSpeechRecognition,
  transcriptTurns,
  visitorTurns,
} from './helpers.js';

test.beforeEach(async ({ page, context }) => {
  await grantMicrophone(context);
  await stubSpeechRecognition(page);
});

test('books a table by voice, from greeting to reference', async ({ page }) => {
  const friday = seededFriday();

  await gotoApp(page);
  await startConversation(page);

  // Pressing Talk opens the microphone and says so, in text as well as motion.
  await expect(page.locator('#talk')).toHaveAttribute('data-state', 'listening');
  await expect(page.locator('.listening-indicator__status')).toHaveText('Listening');

  for (const said of [friday, 'seven pm', 'two of us', 'Karani', '9820011447', 'yes please']) {
    await sayAloud(page, said);
  }

  await expectBooked(page);
  await expect(slotValue(page, 'date')).toHaveText(formatDateLong(friday));
  await expect(slotValue(page, 'time')).toHaveText('7:00 pm');
  await expect(slotValue(page, 'partySize')).toHaveText('2 guests');
  await expect(agentTurns(page).last()).toContainText('Booked.');
});

test('renders interim speech faintly and settles it when the final result lands', async ({
  page,
}) => {
  await gotoApp(page);
  await startConversation(page);

  // Interim results are re-emitted on a timer so the unsettled state can be
  // observed: a single interim would be endpointed into a final after 600ms of
  // silence, which is correct behaviour and useless to look at.
  await page.evaluate(() => {
    window.__interimHold = setInterval(() => {
      window.__emitTranscript?.('table for tw', false);
    }, 120);
  });

  const interim = page.locator('.transcript__turn--interim');
  await expect(interim).toBeVisible();
  await expect(interim).toHaveText('table for tw');

  // Unsettled text is dimmer than settled text, and hidden from screen readers
  // until it is worth reading.
  const opacity = Number(await interim.evaluate((node) => getComputedStyle(node).opacity));
  expect(opacity).toBeGreaterThan(0);
  expect(opacity).toBeLessThan(1);
  await expect(interim).toHaveAttribute('aria-hidden', 'true');

  await page.evaluate(() => {
    if (window.__interimHold !== undefined) clearInterval(window.__interimHold);
  });
  await sayAloud(page, 'table for two');

  // It settles in place rather than being replaced: full opacity, no longer
  // marked interim, and readable by a screen reader.
  await expect(page.locator('.transcript__turn--interim')).toHaveCount(0);
  const settled = visitorTurns(page).filter({ hasText: 'table for two' }).first();
  await expect(settled).toHaveCSS('opacity', '1');
  await expect(settled).not.toHaveAttribute('aria-hidden', 'true');
});

/**
 * A regression guard, and a reminder of how it broke.
 *
 * A final recognition result reaches the orchestrator twice — once through
 * `onTranscript` and once through the endpointer's `onEndOfSpeech`. They are the
 * same event by two routes, and both used to write to the transcript, so every
 * spoken turn was printed twice. `onTranscript` now emits only interim text;
 * `handleTurn` is the single writer.
 *
 * The typed path was never affected, which is why this needs the spoken path to
 * catch it.
 */
test('shows each spoken utterance once', async ({ page }) => {

  await gotoApp(page);
  await startConversation(page);

  const before = await transcriptTurns(page).count();
  await sayAloud(page, 'table for two');

  await expect(visitorTurns(page).filter({ hasText: 'table for two' })).toHaveCount(1);
  expect(await transcriptTurns(page).count()).toBe(before + 2);
});
