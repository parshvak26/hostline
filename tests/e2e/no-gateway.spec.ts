/**
 * R-31 and R-34: the demo books a table with the backend entirely unreachable.
 *
 * The claim being tested is not "the app handles an error from the gateway" but
 * "there is no gateway, and nothing about the visitor's experience depends on
 * one". So every request that leaves the page's own origin is aborted at the
 * network layer — not stubbed, not failed with a status, aborted — and the
 * booking is then completed in full.
 *
 * The second test takes the floor out too: no `SpeechRecognition`, no
 * `webkitSpeechRecognition`, no `navigator.mediaDevices`. That is the last rung
 * of the degradation chain, and it still ends with a reference code.
 */

import { expect, test, type Page } from '@playwright/test';
import {
  bookByTyping,
  expectBooked,
  gotoApp,
  modeTag,
  seededFriday,
  startTyping,
  turnsForPartyOfTwo,
} from './helpers.js';

/** Abort anything that is not the page's own origin. */
async function cutTheNetwork(page: Page, origin: string): Promise<string[]> {
  const blocked: string[] = [];
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(origin)) {
      await route.continue();
      return;
    }
    blocked.push(url);
    await route.abort('connectionrefused');
  });
  return blocked;
}

function originOf(page: Page, baseURL: string | undefined): string {
  const base = baseURL ?? page.url();
  return new URL(base).origin;
}

test.describe('with the gateway unreachable', () => {
  test('completes a booking and says so, without showing the visitor an error', async ({
    page,
    baseURL,
  }) => {
    const blocked = await cutTheNetwork(page, originOf(page, baseURL));
    const friday = seededFriday();

    await gotoApp(page);
    await startTyping(page);

    // The tag is the honest disclosure, not an apology: it is present from the
    // first frame of the conversation because this build has no model at all.
    await expect(modeTag(page)).toBeVisible();
    await expect(modeTag(page)).toContainText('simple mode');

    await bookByTyping(page, turnsForPartyOfTwo(friday));
    const reference = await expectBooked(page);
    expect(reference).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);

    // Nothing in the conversation tells the visitor something went wrong: no
    // fallback panel, no assertive error announcement, no apology on screen.
    await expect(page.locator('#fallback')).toBeHidden();
    await expect(page.locator('#live-error')).toHaveText('');
    await expect(
      page.locator('#conversation').getByText(/went wrong|could not|unable to|try again|stopped working/i),
    ).toHaveCount(0);

    // If anything did leave the origin it was refused, and the booking still
    // happened — which is the point rather than a caveat.
    expect(blocked.every((url) => !url.startsWith(originOf(page, baseURL)))).toBe(true);
  });

  test('books with no recognition API and no microphone at all', async ({ page, baseURL }) => {
    await cutTheNetwork(page, originOf(page, baseURL));

    await page.addInitScript(() => {
      const scope = window as unknown as Record<string, unknown>;
      delete scope['SpeechRecognition'];
      delete scope['webkitSpeechRecognition'];
      Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });
      Object.defineProperty(window, 'webkitSpeechRecognition', {
        value: undefined,
        configurable: true,
      });
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    });

    const friday = seededFriday();
    await gotoApp(page);

    // Belt and braces: the app must be looking at the world the test built.
    const capabilities = await page.evaluate(() => ({
      recognition: typeof (window as unknown as Record<string, unknown>)['SpeechRecognition'],
      webkitRecognition: typeof (window as unknown as Record<string, unknown>)['webkitSpeechRecognition'],
      media: typeof navigator.mediaDevices,
    }));
    expect(capabilities.recognition).toBe('undefined');
    expect(capabilities.webkitRecognition).toBe('undefined');
    expect(capabilities.media).toBe('undefined');

    await startTyping(page);
    await bookByTyping(page, turnsForPartyOfTwo(friday));
    await expectBooked(page);

    await expect(page.locator('#fallback')).toBeHidden();
  });
});
