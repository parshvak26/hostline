/**
 * The diary — what the restaurant sees.
 *
 * It is the only screen that shows the engine disagreeing with the model, so
 * the refused proposal and its reason are the part worth protecting. The rest
 * of this spec is about honesty: seeded rows are labelled as demo data in
 * words, the visitor's own booking is labelled in words too, and the control
 * that deletes everything says what it is about to do before it does it.
 */

import { expect, test } from '@playwright/test';
import {
  bookByTyping,
  diaryRows,
  diaryScroller,
  diarySection,
  expectBooked,
  formatDateLong,
  gotoApp,
  seededFriday,
  startTyping,
  turnsForPartyOfFour,
} from './helpers.js';

/** Seven blocking + two colour on the Friday, three on the Thursday before. */
const SEEDED_ROWS = 12;

test.beforeEach(async ({ page }) => {
  const friday = seededFriday();
  await gotoApp(page);
  await startTyping(page);
  // The party of four is refused at seven, which is what puts a rejection in
  // the transcript for the diary to display.
  await bookByTyping(page, turnsForPartyOfFour(friday));
  await expectBooked(page);
  await page.getByRole('button', { name: 'View the diary' }).click();
  await expect(diarySection(page)).toBeVisible();
});

test('lists the seeded service alongside the visitor’s booking, labelled in words', async ({
  page,
}) => {
  const friday = seededFriday();

  await expect(diaryRows(page)).toHaveCount(SEEDED_ROWS + 1);
  const scroller = diaryScroller(page);
  await expect(scroller).toBeVisible();
  await expect(scroller).toHaveAttribute('aria-label', 'The diary');
  await expect(page.locator('.diary-table__caption').filter({ hasText: formatDateLong(friday) })).toHaveCount(1);

  // A few of the seeded bookings, by name, so this fails if the seed stops
  // being applied rather than merely changing shape.
  for (const name of ['Menon', 'Sequeira', 'Chowdhury', 'Patel']) {
    await expect(diaryRows(page).filter({ hasText: name })).toHaveCount(1);
  }

  // The marker is a word, not a colour: someone who cannot see the accent still
  // knows which row is theirs and which rows are made up.
  const mine = diaryRows(page).filter({ hasText: 'Karani' });
  await expect(mine).toHaveCount(1);
  await expect(mine.locator('.diary-table__marker')).toHaveText('new');
  await expect(mine).toHaveAttribute('data-new', 'true');

  const seeded = diaryRows(page).filter({ hasText: 'Menon' }).locator('.diary-table__marker');
  await expect(seeded).toHaveText('demo');
});

test('opens the transcript and shows the proposal the engine refused, with its reason', async ({
  page,
}) => {
  const open = page.getByRole('button', { name: /Read the conversation/ });
  await expect(open).toHaveCount(1);
  await expect(open).toHaveAttribute('aria-expanded', 'false');

  await open.click();
  await expect(open).toHaveAttribute('aria-expanded', 'true');

  const panel = page.locator('.diary__panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Karani');
  await expect(panel.locator('.diary__turn')).not.toHaveCount(0);

  // The refusal, in full: what happened, the machine-readable reason, and the
  // sentence a person can read.
  const rejection = page.locator('.diary__rejection');
  await expect(rejection).toHaveCount(1);
  await expect(rejection).toContainText('The engine refused this proposal');
  await expect(rejection.locator('.diary__rejection-reason')).toHaveText('no_availability');
  await expect(rejection.locator('.diary__rejection-detail')).toContainText('fully booked');
  await expect(rejection).toHaveAttribute('data-reason', 'no_availability');
});

test('clears the demo data in two steps and comes back to the seeded diary', async ({ page }) => {
  const clear = page.getByRole('button', { name: 'Clear demo data' });
  await expect(clear).toHaveAttribute('aria-expanded', 'false');

  // Step one: it asks, and says what it is about to remove.
  await clear.click();
  await expect(clear).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('This removes every booking and conversation stored in this browser.')).toBeVisible();

  // Backing out changes nothing.
  await page.getByRole('button', { name: 'Keep it' }).click();
  await expect(page.locator('.diary__confirm')).toBeHidden();
  await expect(diaryRows(page)).toHaveCount(SEEDED_ROWS + 1);

  // Step two: confirm, and it says what it did.
  await clear.click();
  await page.getByRole('button', { name: 'Yes, clear it' }).click();
  await expect(page.locator('.diary__status')).toHaveText(
    'Cleared — nothing from this demo is left in the browser.',
  );

  // The demo is meant to survive being wiped: the next visit reseeds, and the
  // visitor's booking is gone.
  await page.reload();
  await expect(page.locator('.conversation__layout')).toBeAttached();

  await expect.poll(() => diaryRows(page).count()).toBe(SEEDED_ROWS);
  await expect(diaryRows(page).filter({ hasText: 'Karani' })).toHaveCount(0);
  await expect(page.locator('.diary-table__marker--new')).toHaveCount(0);
  await expect(page.locator('.diary-table__marker--yours')).toHaveCount(0);
  await expect(page.locator('.diary-table__marker--demo')).toHaveCount(SEEDED_ROWS);
  await expect(page.locator('.diary-table__empty')).toHaveText(
    "Nothing of yours yet — talk to us and it'll appear here.",
  );

  // And with nothing of the visitor's in it, the diary is out of the way again.
  await expect(diarySection(page)).toBeHidden();
});
