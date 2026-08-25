#!/usr/bin/env node
/**
 * Capture the README's screenshots from the real, built site (T-120, §24 item 6).
 *
 * Plan §24 asks for "real screenshots, not mockups". Taking them by hand means
 * they drift the moment the design changes and nobody notices until someone
 * points at a screenshot of a page that no longer exists. This drives the built
 * output through a real browser, so a stale screenshot is a command away from
 * being fixed and a design change that breaks the layout shows up here.
 *
 * It also fails on a console error or a failed request — a screenshot of a page
 * that logged an exception is not evidence of anything.
 *
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/screenshots.mjs
 */

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.HOSTLINE_URL ?? 'http://localhost:4173/hostline/';
const OUT = new URL('../docs/images/', import.meta.url).pathname;

/** Typed, not spoken: a headless browser has no microphone, and the typed path
 *  is a first-class route through exactly the same engine. */
const TURNS = [
  'do you have a table for four on friday',
  'seven pm',
  'quarter past eight then',
  "it's under Karani",
  'nine eight two zero zero double one four four seven',
  'yes please',
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const problems = [];

function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${label}: console ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${label}: ${String(e)}`));
  page.on('requestfailed', (r) => problems.push(`${label}: failed ${r.url()}`));
}

async function converse(page, turns) {
  await page.locator('#talk').click();
  await page.waitForTimeout(500);
  const input = page.locator('input[type="text"], input:not([type])').first();
  for (const turn of turns) {
    await input.fill(turn);
    await input.press('Enter');
    await page.waitForTimeout(420);
  }
  await page.waitForTimeout(600);
}

/* ---- 1. the hero, as a first-time visitor meets it ---------------------- */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  watch(page, 'hero');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}hero.png` });
  await page.close();
}

/* ---- 2. mid-conversation, the slots filling in -------------------------- */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  watch(page, 'conversation');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await converse(page, TURNS.slice(0, 4));
  await page.locator('#conversation').screenshot({ path: `${OUT}conversation.png` });
  await page.close();
}

/* ---- 3. the diary, with the new booking marked -------------------------- */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  watch(page, 'diary');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await converse(page, TURNS);
  // The diary is revealed by the confirmation card's call to action, not
  // automatically — plan §4.1 makes it a deliberate step the visitor takes.
  await page.getByRole('button', { name: /diary/i }).first().click();
  await page.waitForTimeout(500);
  await page.locator('#diary').screenshot({ path: `${OUT}diary.png` });
  await page.close();
}

/* ---- 4. how it works, including the hand-drawn diagram ------------------ */
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  watch(page, 'how-it-works');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('#how-it-works').screenshot({ path: `${OUT}how-it-works.png` });
  await page.close();
}

/* ---- 5. a phone, because a large share of link clicks are on one -------- */
{
  const page = await browser.newPage({ viewport: { width: 375, height: 667 }, isMobile: true });
  watch(page, 'mobile');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}mobile.png` });
  await page.close();
}

await browser.close();

if (problems.length > 0) {
  console.error('\nThe page reported problems while being photographed:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nScreenshots were still written, but fix these before publishing them.\n');
  process.exit(1);
}

console.log(`Wrote 5 screenshots to docs/images/ from ${BASE}`);
