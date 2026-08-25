/**
 * R-07: "actually make it five" after the read-back.
 *
 * This is the failure mode the confirmation policy exists to prevent. A change
 * arriving after the read-back has to void the confirmation, re-check the room
 * at the new size, and ask again — because the alternative is a booking for
 * four made by someone who said five and heard nothing to the contrary.
 *
 * Everything asserted here happens *before* anything is committed.
 */

import { expect, test } from '@playwright/test';
import {
  agentTurns,
  confirmationCard,
  expectBooked,
  gotoApp,
  seededFriday,
  slotRow,
  slotValue,
  startTyping,
  typeTurn,
} from './helpers.js';

test('a party-size change after the read-back voids the confirmation and asks again', async ({
  page,
}) => {
  const friday = seededFriday();

  await gotoApp(page);
  await startTyping(page);

  for (const turn of [friday, 'seven pm', 'two of us', 'Karani', '9820011447']) {
    await typeTurn(page, turn);
  }

  // The read-back is on the table: every slot checked, none of them written
  // down yet. `confirmed` is what the engine marks a slot once it has committed.
  await expect(agentTurns(page).last()).toContainText('Shall I book that?');
  await expect(agentTurns(page).last()).toContainText('2 guests');
  await expect(slotRow(page, 'partySize')).toHaveAttribute('data-state', 'validated');
  await expect(slotRow(page, 'partySize').locator('.slot-panel__marker')).toHaveText('checked');
  await expect(confirmationCard(page)).toBeHidden();

  await typeTurn(page, 'actually make it five');

  // The size changed…
  await expect(slotValue(page, 'partySize')).toHaveText('5 guests');

  // …and nothing was written down on the way past: no confirmation card, and
  // no row in the diary, which is the only place a committed booking appears.
  await expect(confirmationCard(page)).toBeHidden();
  await expect(page.locator('.diary-table__row').filter({ hasText: 'Karani' })).toHaveCount(0);

  // …and the room was re-checked at the new size rather than assumed. Five
  // people need a six-top, and both are taken across seven o'clock.
  await expect(agentTurns(page).last()).toContainText(/We are full at 7pm|7pm has gone/);
  await expect(slotValue(page, 'time')).toHaveText('—');

  // The agent asks again before anything is committed.
  await typeTurn(page, 'half past eight');
  await expect(agentTurns(page).last()).toContainText('Shall I book that?');
  await expect(agentTurns(page).last()).toContainText('5 guests');
  await expect(confirmationCard(page)).toBeHidden();

  await typeTurn(page, 'yes please');
  await expectBooked(page);

  // The booking that exists is the corrected one.
  await expect(slotRow(page, 'partySize')).toHaveAttribute('data-state', 'confirmed');
  await expect(slotValue(page, 'partySize')).toHaveText('5 guests');
  await expect(slotValue(page, 'time')).toHaveText('8:30 pm');
  await expect(page.locator('.confirmation__summary')).toContainText('5 guests');

  await page.getByRole('button', { name: 'View the diary' }).click();
  const mine = page.locator('.diary-table__row').filter({ hasText: 'Karani' });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText('5 guests');
});
