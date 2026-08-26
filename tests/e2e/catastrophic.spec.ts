/**
 * F12: the floor.
 *
 * Everything above this has a fallback. This is what happens when something the
 * fallbacks did not anticipate throws: a panel that says so in readable words,
 * with a way out. Never a blank page — which is the actual failure mode this
 * exists to rule out, so the test asserts on what a visitor can read rather
 * than only on the panel being present.
 */

import { expect, test } from '@playwright/test';
import { fallbackPanel, gotoApp } from './helpers.js';

test('an uncaught error reveals the fallback panel, not a blank page', async ({ page }) => {
  await gotoApp(page);
  await expect(fallbackPanel(page)).toBeHidden();

  await page.evaluate(() => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'injected by the e2e suite' }));
  });

  const panel = fallbackPanel(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'The demo stopped' })).toBeVisible();
  await expect(panel.locator('.fallback-panel__message')).toHaveText(
    'Something in this page stopped working.',
  );

  // A way out, and it goes somewhere real.
  const source = panel.getByRole('link', { name: 'Read the source on GitHub' });
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute('href', 'https://github.com/parshvak26/hostline');

  // Readable, not a hairline of collapsed text.
  const box = await panel.boundingBox();
  expect(box, 'the fallback panel has no box').not.toBeNull();
  expect(box === null ? 0 : box.height, 'the fallback panel is not readable').toBeGreaterThan(40);

  // The page underneath is still a page: the hero has not been torn down.
  await expect(page.getByRole('heading', { name: 'Reservations, answered.' })).toBeVisible();
});

test('an unhandled rejection reveals it too', async ({ page }) => {
  await gotoApp(page);
  await expect(fallbackPanel(page)).toBeHidden();

  // The other half of the handler in `installFallback`: an async failure that
  // nobody caught looks exactly like a thrown error to a visitor.
  await page.evaluate(() => {
    void Promise.reject(new Error('injected by the e2e suite'));
  });

  await expect(fallbackPanel(page)).toBeVisible();
  await expect(fallbackPanel(page).locator('.fallback-panel__message')).toHaveText(
    'Something in this page stopped working.',
  );
});

test('a third-party script throwing does not raise the panel over a working page', async ({ page }) => {
  // Turnstile once threw on a parameter it had stopped accepting. The page was
  // working perfectly — the booking path does not need Turnstile — but the
  // throw reached `window.onerror` and replaced a live demo with an apology.
  // The panel is the floor beneath *this application* failing, and a script on
  // someone else's origin is not that.
  await gotoApp(page);
  await expect(fallbackPanel(page)).toBeHidden();

  await page.evaluate(() => {
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'TurnstileError: pretend a third-party widget threw',
        filename: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
      }),
    );
  });

  await expect(fallbackPanel(page)).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Reservations, answered.' })).toBeVisible();
});
