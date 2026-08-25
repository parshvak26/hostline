/**
 * The designed demo moment (plan §10.6).
 *
 * A reviewer asks for the most obvious thing — a table for four, on Friday, at
 * seven — and the seeded diary makes exactly that unbookable. What matters is
 * not that it is refused but that the refusal is *useful*: three real times,
 * computed from table inventory, one of which then books.
 *
 * The count is asserted because it is a designed number. Five four-tops and two
 * six-tops occupied across 19:00 leaves 20:15, 20:30 and 20:45 inside the
 * engine's ±120-minute search — move the seed and this test is what says so.
 */

import { expect, test } from '@playwright/test';
import {
  agentTurns,
  expectBooked,
  formatDateLong,
  gotoApp,
  seededFriday,
  slotValue,
  startTyping,
  typeTurn,
} from './helpers.js';

/** The offer reads "…I could do quarter past 8, half past 8 or quarter to 9." */
function offeredTimes(line: string): string[] {
  const match = /(?:I could do|I have)\s+(.*?)\.?$/.exec(line);
  const list = match === null ? '' : (match[1] ?? '');
  return list
    .split(/,\s*|\s+or\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

test('refuses the full slot for a party of four and offers exactly three alternatives', async ({
  page,
}) => {
  const friday = seededFriday();

  await gotoApp(page);
  await startTyping(page);

  await typeTurn(page, friday);
  await typeTurn(page, 'seven pm');
  await typeTurn(page, 'four of us');

  const refusal = agentTurns(page).last();
  await expect(refusal).toContainText('7pm');
  await expect(refusal).toContainText(/We are full at|has gone/);

  const spoken = (await refusal.textContent()) ?? '';
  const offered = offeredTimes(spoken);
  expect(offered, `alternatives offered in "${spoken}"`).toHaveLength(3);

  // The three the seeded diary is arranged to leave free.
  expect(offered).toEqual(['quarter past 8', 'half past 8', 'quarter to 9']);

  // A time the engine knows is full must not be left sitting in the panel as
  // though it were held.
  await expect(slotValue(page, 'time')).toHaveText('—');
  await expect(slotValue(page, 'partySize')).toHaveText('4 guests');

  // Accept one of them and the booking completes normally.
  await typeTurn(page, 'quarter past eight');
  await expect(slotValue(page, 'time')).toHaveText('8:15 pm');

  await typeTurn(page, 'Karani');
  await typeTurn(page, '9820011447');
  await expect(agentTurns(page).last()).toContainText('Shall I book that?');

  await typeTurn(page, 'yes please');
  await expectBooked(page);

  await expect(slotValue(page, 'date')).toHaveText(formatDateLong(friday));
  await expect(slotValue(page, 'time')).toHaveText('8:15 pm');
  await expect(slotValue(page, 'partySize')).toHaveText('4 guests');
});

test('still seats a party of two at the same hour, because the two-tops are free', async ({
  page,
}) => {
  // The refusal above is about the room, not about the clock. If seven o'clock
  // were simply switched off the demo would be a lie, so this is the other half
  // of the same assertion.
  const friday = seededFriday();

  await gotoApp(page);
  await startTyping(page);

  await typeTurn(page, friday);
  await typeTurn(page, 'seven pm');
  await typeTurn(page, 'two of us');

  await expect(slotValue(page, 'time')).toHaveText('7:00 pm');
  await expect(agentTurns(page).last()).not.toContainText('full');
});
