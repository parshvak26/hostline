/**
 * 200% browser zoom (plan §14: "usable at 375px wide and at 200% browser zoom
 * without horizontal scrolling").
 *
 * Zoom is emulated by halving the viewport, which is what doubling the zoom
 * does to the CSS pixel budget a layout has to work in: a 1280×1080 window at
 * 200% gives a page 640×540 CSS pixels. The device pixel ratio is doubled too,
 * so anything sized in device pixels is exercised the same way.
 *
 * Skipped on the phone profiles, where the viewport is already the constraint
 * and overriding it would be testing a device that does not exist.
 */

import { expect, test } from '@playwright/test';
import {
  bookByTyping,
  expectBooked,
  expectNoHorizontalScroll,
  gotoApp,
  seededFriday,
  startTyping,
  turnsForPartyOfFour,
} from './helpers.js';

const MOBILE_PROJECTS = ['iphone-se', 'pixel-5'];

test.use({ viewport: { width: 640, height: 540 }, deviceScaleFactor: 2 });

test('completes a booking at 200% zoom without scrolling sideways', async ({ page }, testInfo) => {
  test.skip(
    MOBILE_PROJECTS.includes(testInfo.project.name),
    'the phone profiles set their own viewport',
  );

  const friday = seededFriday();

  await gotoApp(page);
  await expectNoHorizontalScroll(page, 'hero');
  await expect(page.getByText('Ember & Oak', { exact: true })).toBeVisible();

  await startTyping(page);
  await expectNoHorizontalScroll(page, 'conversation');

  // The refusal-and-alternatives turn is the longest line the agent ever says,
  // so it is the one most likely to push the layout wide.
  for (const [index, turn] of turnsForPartyOfFour(friday).entries()) {
    await bookByTyping(page, [turn]);
    await expectNoHorizontalScroll(page, `turn ${String(index + 1)}`);
  }

  await expectBooked(page);
  await expectNoHorizontalScroll(page, 'confirmation');

  await page.getByRole('button', { name: 'View the diary' }).click();
  await expect(page.locator('#diary')).toBeVisible();
  await expectNoHorizontalScroll(page, 'diary');

  await page.getByRole('button', { name: /Read the conversation/ }).click();
  await expect(page.locator('.diary__panel')).toBeVisible();
  await expectNoHorizontalScroll(page, 'diary with a transcript open');

  await page.locator('#how-it-works').scrollIntoViewIfNeeded();
  await expectNoHorizontalScroll(page, 'how it works');
});
