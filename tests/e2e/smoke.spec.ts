/**
 * The page loads, and loads cleanly.
 *
 * This runs against the built output under the real `/hostline/` base path, so
 * a wrong asset path, a Content-Security-Policy that blocks the app's own
 * bundle, or a font that never arrives fails here rather than on the deploy.
 */

import { expect, test } from '@playwright/test';
import { gotoApp, talkButton, watchForProblems } from './helpers.js';

test.describe('first paint', () => {
  test('serves the restaurant at the base path with the Talk button above the fold', async ({
    page,
  }) => {
    await gotoApp(page);

    await expect(page).toHaveTitle(/Ember & Oak/);
    expect(new URL(page.url()).pathname).toBe('/hostline/');

    const name = page.getByText('Ember & Oak', { exact: true });
    await expect(name).toBeVisible();

    const button = talkButton(page);
    await expect(button).toBeVisible();
    await expect(button).toHaveAccessibleName('Talk to us');

    // "Above the fold" is the literal claim the hero makes: no scrolling before
    // a visitor can see where they are and what to press.
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const fold = viewport?.height ?? 0;

    for (const [label, locator] of [
      ['restaurant name', name],
      ['talk button', button],
    ] as const) {
      const box = await locator.boundingBox();
      expect(box, `${label} has no box`).not.toBeNull();
      expect(box === null ? Infinity : box.y + box.height, `${label} is below the fold`).toBeLessThanOrEqual(fold);
    }
  });

  test('loads the display face rather than falling back to a system serif', async ({ page }) => {
    await gotoApp(page);

    // The headline is the reason the font is preloaded, so it is the thing that
    // has to actually be set in it.
    const resolved = await page.evaluate(() => {
      const headline = document.querySelector('.headline');
      return {
        loaded: document.fonts.check('700 3rem Fraunces'),
        family: headline === null ? '' : getComputedStyle(headline).fontFamily,
      };
    });

    expect(resolved.loaded).toBe(true);
    expect(resolved.family).toMatch(/Fraunces/);
  });

  test('reports no console errors and no failed requests on load', async ({ page }) => {
    const problems = watchForProblems(page);

    await gotoApp(page);
    // The warm-up runs after first paint; a CSP that blocks it would only be
    // visible once it has had a chance to run.
    await expect(page.locator('.how-it-works__figure')).toBeVisible();

    expect(problems.pageErrors, 'uncaught exceptions on load').toEqual([]);
    expect(problems.consoleErrors, 'console errors on load').toEqual([]);
    expect(problems.failedRequests, 'failed or 4xx/5xx requests on load').toEqual([]);
  });
});

/**
 * The hero is in the HTML, not built by script.
 *
 * With JavaScript off, a visitor still gets a real restaurant page with a link
 * to the source — the floor beneath every other failure state (plan §7.5 F12).
 */
test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('still serves the hero, the headline and a link to the source', async ({ page }) => {
    await page.goto('./');

    await expect(page.getByText('Ember & Oak', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reservations, answered.' })).toBeVisible();
    await expect(page.locator('#talk')).toBeVisible();
    await expect(page.getByRole('link', { name: 'source on GitHub' })).toBeVisible();

    // Nothing hydrated, so the conversation is still hidden rather than broken.
    await expect(page.locator('#conversation')).toBeHidden();
  });
});
