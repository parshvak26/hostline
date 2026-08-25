/**
 * R-08: the whole booking completes by typing, with no microphone.
 *
 * The permission is never granted, so if any part of the flow reached for the
 * microphone the test would stall rather than quietly degrade. The route in is
 * "Rather type?" — the choice a visitor makes before they have been asked for
 * anything, which is the version of this path that has to work first.
 */

import { expect, test } from '@playwright/test';
import {
  bookByTyping,
  confirmationCard,
  diaryRows,
  expectBooked,
  formatDateLong,
  gotoApp,
  seededFriday,
  slotValue,
  startTyping,
  turnsForPartyOfTwo,
} from './helpers.js';

test('books a table end to end by typing, with the microphone denied', async ({ page, context }) => {
  await context.clearPermissions();

  const friday = seededFriday();
  await gotoApp(page);
  await startTyping(page);

  // Nothing is booked until the visitor says so.
  await expect(confirmationCard(page)).toBeHidden();

  await bookByTyping(page, turnsForPartyOfTwo(friday));

  // The panel is the running record of what the engine has actually accepted.
  await expect(slotValue(page, 'date')).toHaveText(formatDateLong(friday));
  await expect(slotValue(page, 'time')).toHaveText('7:00 pm');
  await expect(slotValue(page, 'partySize')).toHaveText('2 guests');
  await expect(slotValue(page, 'name')).toHaveText('Karani');
  await expect(slotValue(page, 'phone')).toHaveText('98200 11447');

  const reference = await expectBooked(page);

  // The read-back has to have happened before the booking, or the visitor
  // agreed to something they were never told.
  await expect(page.locator('.transcript__turn--agent').filter({ hasText: 'Shall I book that?' })).toHaveCount(1);
  await expect(page.locator('.transcript__turn--agent').last()).toContainText('Booked.');

  // And it is in the diary the restaurant would be looking at.
  await page.getByRole('button', { name: 'View the diary' }).click();
  await expect(page.locator('#diary')).toBeVisible();

  const mine = diaryRows(page).filter({ hasText: 'Karani' });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText('7:00 pm');
  await expect(mine).toContainText('2 guests');
  await expect(mine).toHaveAttribute('data-new', 'true');

  expect(reference).toHaveLength(5);
});
