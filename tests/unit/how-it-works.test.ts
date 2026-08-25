// @vitest-environment jsdom
/**
 * T-106. The section that has to be true as well as pretty.
 *
 * Most of these are guards rather than behaviour tests: the diagram is a
 * hand-authored string that lint deliberately stops checking, so the checks it
 * would otherwise get — no hex, no script, no filter — are made here instead.
 */
import { describe, expect, it } from 'vitest';
import { createHowItWorks } from '../../src/ui/views/how-it-works.js';
import { PUBLIC_CONFIG } from '../../src/config/settings.js';

const WORD_CEILING = 200;

/** Whitespace-separated tokens containing a letter or a digit. */
function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

function render(): HTMLElement {
  return createHowItWorks().el;
}

function diagram(root: HTMLElement): SVGSVGElement {
  const svg = root.querySelector('svg');
  if (svg === null) throw new Error('the section rendered without its diagram');
  return svg as unknown as SVGSVGElement;
}

function serialise(node: Node): string {
  return new XMLSerializer().serializeToString(node);
}

describe('createHowItWorks', () => {
  it('returns a component whose update is safe to call with no props', () => {
    const component = createHowItWorks();
    expect(component.el).toBeInstanceOf(HTMLElement);
    expect(() => component.update()).not.toThrow();
    expect(component.el.querySelectorAll('h2').length).toBeGreaterThanOrEqual(4);
  });

  it('opens with the problem, in three sentences and with no statistic', () => {
    const problem = render().querySelector('.how-it-works__problem p');
    const text = problem?.textContent ?? '';
    expect(text.split('.').filter((part) => part.trim() !== '')).toHaveLength(3);
    expect(text).not.toMatch(/\d/);
  });

  /* ---- The diagram ----------------------------------------------------- */

  it('exposes the diagram to assistive technology as a single image', () => {
    expect(diagram(render()).getAttribute('role')).toBe('img');
  });

  it('gives the diagram a non-empty title', () => {
    const title = diagram(render()).querySelector('title');
    expect((title?.textContent ?? '').trim().length).toBeGreaterThan(10);
  });

  it('describes the architecture in the desc, not just names it', () => {
    const desc = (diagram(render()).querySelector('desc')?.textContent ?? '').trim();
    expect(desc.length).toBeGreaterThan(300);
    // The boundary is the point of the diagram, so the description must carry it.
    expect(desc).toMatch(/suggest/i);
    expect(desc).toMatch(/only part of the system that can write a booking/i);
    expect(desc).toMatch(/fallback/i);
  });

  it('points aria-labelledby at both the title and the desc', () => {
    const svg = diagram(render());
    const ids = (svg.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter((id) => id !== '');
    expect(ids).toHaveLength(2);

    const titleId = svg.querySelector('title')?.getAttribute('id');
    const descId = svg.querySelector('desc')?.getAttribute('id');
    expect(ids).toContain(titleId);
    expect(ids).toContain(descId);
  });

  it('scales with its container instead of assuming a width', () => {
    const svg = diagram(render());
    expect(svg.getAttribute('viewBox')).toMatch(/^0 0 \d+ \d+$/);
    expect(svg.getAttribute('preserveAspectRatio')).toBeTruthy();
    expect(svg.getAttribute('width')).toBeNull();
    expect(svg.getAttribute('height')).toBeNull();
  });

  it('carries no raw hex colour — the palette leak the CSS grep cannot see', () => {
    expect(serialise(diagram(render()))).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('carries no script, filter, or foreignObject', () => {
    const svg = diagram(render());
    const markup = serialise(svg);
    expect(svg.querySelector('script')).toBeNull();
    expect(svg.querySelector('foreignObject')).toBeNull();
    expect(markup).not.toMatch(/<script/i);
    expect(markup).not.toMatch(/foreignObject/i);
    expect(markup).not.toMatch(/filter|blur|drop-shadow|gradient/i);
  });

  /* ---- The words ------------------------------------------------------- */

  it('explains the system in no more than 200 words', () => {
    const explanation = render().querySelector('.how-it-works__explanation');
    const words = countWords(explanation?.textContent ?? '');
    expect(words).toBeGreaterThan(80);
    expect(words).toBeLessThanOrEqual(WORD_CEILING);
  });

  it('tells the three beats in order', () => {
    const paragraphs = Array.from(
      render().querySelectorAll('.how-it-works__explanation p'),
      (node) => node.textContent ?? '',
    );
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]).toMatch(/language model/i);
    expect(paragraphs[1]).toMatch(/crosses the line/i);
    expect(paragraphs[2]).toMatch(/unreachable/i);
  });

  it('shows the three engineering decisions named in the plan', () => {
    const titles = Array.from(
      render().querySelectorAll('.how-it-works__card-title'),
      (node) => node.textContent ?? '',
    );
    expect(titles).toEqual([
      'The AI suggests, the code decides',
      "It works when the AI doesn't",
      "It can't cost anything",
    ]);
  });

  it('links every decision card into the documentation', () => {
    const cards = Array.from(render().querySelectorAll('.how-it-works__card'));
    expect(cards).toHaveLength(3);

    const hrefs = cards.map((card) => card.querySelector('a')?.getAttribute('href') ?? '');
    for (const href of hrefs) {
      expect(href.startsWith(`${PUBLIC_CONFIG.repositoryUrl}/blob/`)).toBe(true);
      expect(href).toMatch(/\/docs\/[a-z-]+\.md$/);
    }
    expect(hrefs.join(' ')).toMatch(/ai-boundary\.md/);
    expect(hrefs.join(' ')).toMatch(/degradation\.md/);
    expect(hrefs.join(' ')).toMatch(/architecture\.md/);
  });

  it('states the limitations on the page, in a bordered aside', () => {
    const aside = render().querySelector('aside.how-it-works__limits');
    expect(aside).not.toBeNull();

    const text = aside?.textContent ?? '';
    expect(text).toMatch(/english only/i);
    expect(text).toMatch(/one restaurant/i);
    expect(text).toMatch(/cannot cancel or change a booking by voice/i);
    expect(text).toMatch(/free tiers that rate-limit/i);
    expect(text).toMatch(/not production software/i);
  });

  it('keeps a source link beside the diagram', () => {
    const link = render().querySelector('.how-it-works__figure a');
    expect(link?.getAttribute('href')).toBe(PUBLIC_CONFIG.repositoryUrl);
    expect((link?.textContent ?? '').toLowerCase()).toContain('source');
  });

  /* ---- What the page must never say ------------------------------------ */

  it('uses no exclamation marks (plan §5.4)', () => {
    expect(render().textContent ?? '').not.toContain('!');
  });

  it('contains none of the things plan §25 forbids', () => {
    const text = (render().textContent ?? '').toLowerCase();
    for (const forbidden of ['cookie', 'newsletter', 'subscribe', 'testimonial', 'built with ai']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
