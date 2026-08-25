/**
 * Accessibility: the gate, and the parts axe cannot see.
 *
 * axe-core runs on all three views plus "How this works", and the gate is zero
 * serious or critical violations (plan §14, §17). Moderate and minor findings
 * are printed rather than failed — they are worth reading, and a suite that
 * fails on "aside inside a landmark" trains people to ignore it.
 *
 * The second half is the part a scanner cannot check: the whole booking done
 * with the keyboard alone, and a focus ring that is actually visible.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  expectBooked,
  gotoApp,
  seededFriday,
  settleAnimations,
  startTyping,
  tabTo,
  talkButton,
  transcriptTurns,
  turnsForPartyOfTwo,
  typeField,
} from './helpers.js';

const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

/** Taken from the builder rather than imported, so axe-core stays transitive. */
type Violation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number];

/**
 * `@axe-core/playwright` types its `page` against whichever `playwright-core`
 * the tree hoists, which is not the copy `@playwright/test` uses. The object is
 * the same one either way; only the nominal type differs.
 */
type AxePage = ConstructorParameters<typeof AxeBuilder>[0]['page'];

function axeFor(page: Page): AxeBuilder {
  return new AxeBuilder({ page: page as unknown as AxePage });
}

function describeViolation(violation: Violation): string {
  const targets = violation.nodes.map((node) => node.target.join(' ')).join(', ');
  return `${violation.impact ?? 'unknown'} · ${violation.id} — ${violation.help} [${targets}]`;
}

async function scan(page: Page, view: string): Promise<void> {
  // Nothing mid-transition: a contrast check on a fading element measures the
  // animation rather than the design.
  await settleAnimations(page);
  const results = await axeFor(page).analyze();

  const blocking = results.violations.filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ''));
  const advisory = results.violations.filter((v) => !BLOCKING_IMPACTS.has(v.impact ?? ''));

  for (const violation of advisory) {
    console.log(`[a11y] ${view}: ${describeViolation(violation)}`);
  }

  expect(blocking.map(describeViolation), `serious or critical violations on ${view}`).toEqual([]);
}

test('has no serious or critical violations on any view', async ({ page }) => {
  const friday = seededFriday();

  await gotoApp(page);
  await scan(page, 'hero');

  // The privacy note is a disclosure that opens in place; it is part of the
  // hero as far as a visitor is concerned.
  await page.getByRole('button', { name: 'What happens to my voice?' }).click();
  await expect(page.locator('#privacy')).toBeVisible();
  await scan(page, 'hero with the privacy note open');

  await page.locator('#how-it-works').scrollIntoViewIfNeeded();
  await scan(page, 'how it works');

  await startTyping(page);
  await scan(page, 'conversation, empty');

  for (const turn of turnsForPartyOfTwo(friday)) {
    const before = await transcriptTurns(page).count();
    await typeField(page).fill(turn);
    await typeField(page).press('Enter');
    await expect.poll(() => transcriptTurns(page).count()).toBeGreaterThan(before + 1);
  }
  await expectBooked(page);
  await scan(page, 'conversation with the confirmation');

  await page.getByRole('button', { name: 'View the diary' }).click();
  await expect(page.locator('#diary')).toBeVisible();
  await page.getByRole('button', { name: /Read the conversation/ }).click();
  await scan(page, 'diary with a transcript open');
});

test('completes the whole booking with the keyboard alone', async ({ page }) => {
  const friday = seededFriday();
  await gotoApp(page);

  // No mouse from here on: Tab to the typing route and open it with Enter.
  const typeInstead = page.getByRole('button', { name: 'Rather type?' });
  await tabTo(page, typeInstead);
  await page.keyboard.press('Enter');

  const field = typeField(page);
  await expect(field).toBeVisible();
  await tabTo(page, field);

  for (const turn of turnsForPartyOfTwo(friday)) {
    const before = await transcriptTurns(page).count();
    await page.keyboard.type(turn);
    await page.keyboard.press('Enter');
    await expect.poll(() => transcriptTurns(page).count()).toBeGreaterThan(before + 1);
  }

  await expectBooked(page);

  // Focus is moved to the confirmation card, which is the whole point of
  // moving it: a keyboard visitor lands on the answer rather than hunting for it.
  await expect(page.locator('.confirmation')).toBeFocused();

  const viewDiary = page.getByRole('button', { name: 'View the diary' });
  await tabTo(page, viewDiary);
  await page.keyboard.press('Enter');
  await expect(page.locator('#diary')).toBeVisible();
});

test('shows a visible focus ring on the Talk button', async ({ page }) => {
  await gotoApp(page);

  const button = talkButton(page);
  await tabTo(page, button);
  await expect(button).toBeFocused();

  const ring = await button.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      width: style.outlineWidth,
      styleName: style.outlineStyle,
      colour: style.outlineColor,
    };
  });

  expect(ring.styleName).not.toBe('none');
  expect(Number.parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
  expect(ring.colour).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
});

test('starts with a skip link that reaches the booking', async ({ page }) => {
  await gotoApp(page);

  const skip = page.getByRole('link', { name: 'Skip to the booking' });
  await page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  await expect(skip).toHaveAttribute('href', '#talk');
});
