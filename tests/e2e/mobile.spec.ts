/**
 * A complete booking on a phone.
 *
 * Runs only on the two mobile profiles, because the thing being asserted is the
 * emulated device rather than the viewport: touch, device pixel ratio and the
 * mobile user agent all feed the layout. Sideways scrolling is checked at every
 * stage rather than once at the end — the hero fits easily and the diary is the
 * screen that does not, so a single check would test the wrong one.
 */

import { expect, test } from '@playwright/test';
import {
  bookByTyping,
  diaryScroller,
  expectBooked,
  expectNoHorizontalScroll,
  gotoApp,
  seededFriday,
  startTyping,
  talkButton,
  turnsForPartyOfTwo,
  typeField,
} from './helpers.js';

const MOBILE_PROJECTS = ['iphone-se', 'pixel-5'];

/** Plan §4.7: a thumb-sized target, on every viewport, in every state. */
const MIN_TOUCH_TARGET_PX = 56;

test('books a table at phone size without ever scrolling sideways', async ({ page }, testInfo) => {
  test.skip(
    !MOBILE_PROJECTS.includes(testInfo.project.name),
    'the mobile profiles are the point of this spec',
  );

  const friday = seededFriday();

  await gotoApp(page);
  await expectNoHorizontalScroll(page, 'hero');

  const button = talkButton(page);
  const box = await button.boundingBox();
  expect(box, 'the Talk button has no box').not.toBeNull();
  expect(box === null ? 0 : box.height, 'the Talk button is smaller than a thumb').toBeGreaterThanOrEqual(
    MIN_TOUCH_TARGET_PX,
  );

  await startTyping(page);
  await expectNoHorizontalScroll(page, 'conversation');
  await expect(typeField(page)).toBeVisible();

  const turns = turnsForPartyOfTwo(friday);
  for (const [index, turn] of turns.entries()) {
    await bookByTyping(page, [turn]);
    await expectNoHorizontalScroll(page, `turn ${String(index + 1)}`);
  }

  await expectBooked(page);
  await expectNoHorizontalScroll(page, 'confirmation');

  // The button keeps its size once it has moved to the lower third.
  const afterBox = await button.boundingBox();
  expect(afterBox === null ? 0 : afterBox.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

  await page.getByRole('button', { name: 'View the diary' }).click();
  await expect(page.locator('#diary')).toBeVisible();
  await expectNoHorizontalScroll(page, 'diary');

  // A wide table is allowed to scroll inside its own region; the page is not.
  await expect(diaryScroller(page)).toBeVisible();
});
