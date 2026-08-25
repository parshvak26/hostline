// @vitest-environment jsdom
/**
 * T-103 and T-110 — the confirmation card and the catastrophic fallback panel.
 *
 * Two components with opposite jobs, tested together because they are the two
 * ends of the same page: the one shown when everything worked, and the one
 * shown when nothing did.
 *
 * The assertions that matter most are the ones about focus and about failure.
 * Focus moving to the card and coming back is T-103's acceptance criterion, and
 * an untested focus move is a focus trap waiting to happen. The fallback panel
 * is asserted with no options at all and with its media element deliberately
 * broken, because those are the conditions it exists to survive — a panel that
 * only works when it is configured correctly is not a floor.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Booking } from '../../src/engine/index.js';
import { createConfirmationCard } from '../../src/ui/components/confirmation.js';
import { createFallbackPanel } from '../../src/ui/components/fallback-panel.js';

const BOOKING: Booking = {
  id: 'id-1',
  reference: 'EM7K4',
  date: '2025-08-29',
  time: '19:00',
  partySize: 4,
  name: 'Priya Nair',
  phone: '9820011447',
  tableId: 't-4',
  durationMinutes: 105,
  createdAt: '2025-08-25T12:00:00.000Z',
  source: 'voice',
  brain: 'llm',
  outcome: 'booked',
  seeded: false,
};

function booking(overrides: Partial<Booking> = {}): Booking {
  return { ...BOOKING, ...overrides };
}

/** Mount so that focus works: jsdom will not focus a detached element. */
function mount(el: HTMLElement): void {
  document.body.append(el);
}

/** The subset of accessible-name computation these components actually use. */
function accessibleName(el: HTMLElement): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    const label = document.getElementById(labelledBy);
    return label === null ? '' : (label.textContent ?? '');
  }
  return el.getAttribute('aria-label') ?? '';
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('createConfirmationCard', () => {
  it('renders the date in long form', () => {
    const card = createConfirmationCard({ onViewDiary: () => {} });
    card.update({ booking: booking() });
    expect(card.el.textContent).toContain('Friday 29 August');
  });

  it('renders the time in 12-hour form', () => {
    const card = createConfirmationCard({ onViewDiary: () => {} });
    card.update({ booking: booking() });
    expect(card.el.textContent).toContain('7:00 pm');
  });

  it('renders the phone number grouped', () => {
    const card = createConfirmationCard({ onViewDiary: () => {} });
    card.update({ booking: booking() });
    expect(card.el.textContent).toContain('98200 11447');
  });

  it('renders the name as given', () => {
    const card = createConfirmationCard({ onViewDiary: () => {} });
    card.update({ booking: booking({ name: 'Priya Nair' }) });
    expect(card.el.textContent).toContain('Priya Nair');
  });

  it('says "1 guest" for a party of one', () => {
    const card = createConfirmationCard({ onViewDiary: () => {} });
    card.update({ booking: booking({ partySize: 1 }) });
    expect(card.el.textContent).toContain('1 guest');
    expect(card.el.textContent).not.toContain('1 guests');
  });

  it('says "4 guests" for a party of four', () => {
    const card = createConfirmationCard({ onViewDiary: () => {} });
    card.update({ booking: booking({ partySize: 4 }) });
    expect(card.el.textContent).toContain('4 guests');
  });

  it('displays the reference, and spells it out for a screen reader', () => {
    const card = createConfirmationCard({ onViewDiary: () => {} });
    card.update({ booking: booking({ reference: 'EM7K4' }) });

    const visible = card.el.querySelector('.confirmation__reference');
    expect(visible?.textContent).toBe('EM7K4');
    // The visible glyphs are spaced by CSS, which a synthesiser cannot see, so
    // the spelled-out copy is what assistive technology is given instead.
    expect(card.el.textContent).toContain('E M 7 K 4');
  });

  it('moves focus to the card when a booking completes', () => {
    const talk = document.createElement('button');
    mount(talk);
    talk.focus();
    expect(document.activeElement).toBe(talk);

    const card = createConfirmationCard({ onViewDiary: () => {} });
    mount(card.el);
    card.update({ booking: booking() });

    expect(document.activeElement).toBe(card.el);
  });

  it('returns focus to where it came from when asked', () => {
    const talk = document.createElement('button');
    mount(talk);
    talk.focus();

    const card = createConfirmationCard({ onViewDiary: () => {} });
    mount(card.el);
    card.update({ booking: booking() });
    card.restoreFocus();

    expect(document.activeElement).toBe(talk);
  });

  it('does not steal focus a second time for the same booking', () => {
    const card = createConfirmationCard({ onViewDiary: () => {} });
    mount(card.el);
    card.update({ booking: booking() });

    const talk = document.createElement('button');
    mount(talk);
    talk.focus();
    card.update({ booking: booking() });

    expect(document.activeElement).toBe(talk);
  });

  it('hides the card, and its contents, for a null booking', () => {
    const card = createConfirmationCard({ onViewDiary: () => {} });
    card.update({ booking: booking() });
    card.update({ booking: null });

    expect(card.el.hidden).toBe(true);
    expect(card.el.textContent).not.toContain('EM7K4');
    expect(card.el.textContent).not.toContain('98200 11447');
  });

  it('renders markup in a name as text and creates no script element', () => {
    const card = createConfirmationCard({ onViewDiary: () => {} });
    mount(card.el);
    card.update({ booking: booking({ name: '<script>alert(1)</script>Nair' }) });

    expect(card.el.querySelector('script')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(card.el.textContent).toContain('<script>alert(1)</script>Nair');
  });

  it('has an accessible name', () => {
    const card = createConfirmationCard({ onViewDiary: () => {} });
    mount(card.el);
    card.update({ booking: booking() });

    expect(accessibleName(card.el).trim()).not.toBe('');
  });

  it('is reachable by keyboard: the diary call-to-action is a real button', () => {
    const onViewDiary = vi.fn();
    const card = createConfirmationCard({ onViewDiary });
    mount(card.el);
    card.update({ booking: booking() });

    const cta = card.el.querySelector('button');
    expect(cta).not.toBeNull();
    cta?.click();
    expect(onViewDiary).toHaveBeenCalledTimes(1);
  });

  it('uses no exclamation marks anywhere in its copy', () => {
    const card = createConfirmationCard({ onViewDiary: () => {} });
    card.update({ booking: booking() });
    expect(card.el.textContent ?? '').not.toContain('!');
  });
});

describe('createFallbackPanel', () => {
  it('renders text and a repository link with no options at all', () => {
    const panel = createFallbackPanel();
    mount(panel.el);

    expect((panel.el.textContent ?? '').trim().length).toBeGreaterThan(0);

    const link = panel.el.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href') ?? '').toContain('github.com');
  });

  it('states what happened and then what to do', () => {
    const panel = createFallbackPanel();
    const text = panel.el.textContent ?? '';

    expect(text).toMatch(/stopped/i);
    expect(text).toMatch(/reload/i);
    expect(text.indexOf('stopped')).toBeLessThan(text.search(/reload/i));
    expect(text).not.toContain('!');
  });

  it('uses the supplied repository URL when it is given one', () => {
    const panel = createFallbackPanel({ repositoryUrl: 'https://example.org/hostline' });
    expect(panel.el.querySelector('a')?.getAttribute('href')).toBe('https://example.org/hostline');
  });

  it('refuses a repository URL that is not http(s), without losing the text', () => {
    const panel = createFallbackPanel({ repositoryUrl: 'javascript:alert(1)' });

    expect(panel.el.querySelector('a')).toBeNull();
    expect(panel.el.textContent ?? '').toMatch(/stopped/i);
  });

  it('shows no player at all when the browser cannot play the recording', () => {
    // jsdom ships no codecs, so `canPlayType` answers '' — the same answer a
    // real browser gives for a format it cannot decode. A dead control strip
    // under an apology is worse than no player.
    const panel = createFallbackPanel();
    expect(panel.el.querySelector('video')).toBeNull();
  });

  it('removes the player, and keeps the text, when the recording fails to load', () => {
    vi.spyOn(HTMLVideoElement.prototype, 'canPlayType').mockReturnValue('probably');

    const panel = createFallbackPanel();
    mount(panel.el);

    // The player is built on first reveal, not on construction: a hidden panel
    // that fetched a caption track would put a 404 in the console of every
    // healthy page load.
    expect(panel.el.querySelector('video')).toBeNull();
    panel.update({});

    const video = panel.el.querySelector('video');
    expect(video).not.toBeNull();

    // The recording has not been produced yet, so this is the live case, not a
    // hypothetical one.
    video?.dispatchEvent(new Event('error'));

    expect(panel.el.querySelector('video')).toBeNull();
    expect(panel.el.querySelector('figure')).toBeNull();
    expect(panel.el.textContent ?? '').toMatch(/stopped/i);
    expect(panel.el.querySelector('a')).not.toBeNull();
  });

  it('builds nothing on construction, so a healthy page load costs no request', () => {
    vi.spyOn(HTMLVideoElement.prototype, 'canPlayType').mockReturnValue('probably');

    const panel = createFallbackPanel();
    expect(panel.el.querySelector('video')).toBeNull();
    expect(panel.el.querySelector('track')).toBeNull();
    // The text is there from the start, though — that is the part that has to
    // survive whatever went wrong.
    expect(panel.el.textContent ?? '').not.toBe('');
  });

  it('carries a caption track on the player', () => {
    vi.spyOn(HTMLVideoElement.prototype, 'canPlayType').mockReturnValue('probably');

    const panel = createFallbackPanel();
    panel.update({});
    const track = panel.el.querySelector('track');

    expect(track?.getAttribute('kind')).toBe('captions');
  });

  it('replaces the default line with a supplied message, and restores it', () => {
    const panel = createFallbackPanel();

    panel.update({ message: 'The microphone was refused; type instead.' });
    expect(panel.el.textContent ?? '').toContain('The microphone was refused; type instead.');

    panel.update({});
    expect(panel.el.textContent ?? '').toMatch(/reload/i);
  });

  it('ignores a blank message rather than rendering an empty panel', () => {
    const panel = createFallbackPanel();
    panel.update({ message: '   ' });
    expect(panel.el.textContent ?? '').toMatch(/stopped/i);
  });

  it('has an accessible name', () => {
    const panel = createFallbackPanel();
    mount(panel.el);
    expect(accessibleName(panel.el).trim()).not.toBe('');
  });
});
