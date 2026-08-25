/**
 * "How this works" — the section that turns a working demo into a claim
 * somebody can check (T-106, plan §25 items 6–10).
 *
 * ## Why this file is allowed to use `innerHTML`
 *
 * `innerHTML` is banned project-wide by lint (plan §13). This module is the
 * single allowlisted exception in `eslint.config.js`, and the exception rests
 * entirely on one property of `DIAGRAM_SVG` below:
 *
 *   **It is a static template literal with no interpolation of any kind.**
 *
 * No `${}`, no concatenation, no value read from anywhere else. That is what
 * makes the string reviewable as an asset rather than as code — you can read it
 * once, satisfy yourself that it contains no sink, and know that it cannot
 * become something else at runtime. Interpolating so much as a colour token
 * would defeat the audit the allowlist rests on, so if this diagram ever needs
 * a dynamic value, it must be set with `setAttribute` on the parsed node
 * instead — never spliced into the string.
 *
 * Every other string on this page reaches the DOM through `textContent`, via
 * the `el()` helper.
 */

import { el } from '../a11y.js';
import { PUBLIC_CONFIG } from '../../config/settings.js';
import type { Component } from '../components/component.js';
import '../styles/components/how-it-works.css';

/**
 * The architecture diagram, hand-authored (plan §6: not a screenshot of a
 * diagram tool).
 *
 * Layout notes, because SVG coordinates are unreadable without them:
 *
 *   - The viewBox is 340 wide so that at a 375px viewport — minus the page
 *     gutters — it renders at roughly 1:1, which is what keeps the 14px labels
 *     legible on a phone (T-106 AC). It is capped, not stretched, on desktop.
 *   - Colour comes from custom properties and `currentColor` only. A hex here
 *     would be a palette leak that the CSS grep could never catch, so a unit
 *     test greps this string instead.
 *   - `var()` is used inside `style` attributes rather than as presentation
 *     attributes (`fill="..."`), because browsers do not substitute custom
 *     properties in presentation attributes.
 *   - The two actors are set in the display serif — they are the characters in
 *     the story. Everything technical is set in the interface sans.
 *   - Arrowheads are drawn as explicit triangles rather than `<marker>`, since
 *     marker content does not inherit colour from the referencing element.
 */
const DIAGRAM_SVG = `<svg
  class="how-it-works__diagram"
  viewBox="0 0 340 448"
  preserveAspectRatio="xMidYMid meet"
  role="img"
  aria-labelledby="hiw-diagram-title hiw-diagram-desc"
  xmlns="http://www.w3.org/2000/svg"
>
  <title id="hiw-diagram-title">How a booking is made: the AI suggests, the booking engine decides</title>
  <desc id="hiw-diagram-desc">A tall diagram in two halves, divided across the middle by a horizontal double rule. Above the rule sits the AI host: it understands speech and phrases the replies, and it suggests booking details but writes nothing. An arrow labelled proposes crosses the rule downwards. Below the rule sits the booking engine: plain, fully tested code with no AI in it, which re-checks every detail it is given, checks whether a table is really free, and is the only part of the system that can write a booking. A second arrow, labelled accepts or rejects, crosses the rule back upwards to the AI host. A dashed line loops from the bottom of the booking engine round to its own top, marked fallback: when the AI is unavailable, the engine runs the whole conversation on its own.</desc>

  <!-- Above the line: the AI host. Outlined, because it is the provisional half. -->
  <rect x="20" y="16" width="300" height="104" rx="2"
    style="fill: none; stroke: var(--rule); stroke-width: 1.5" />
  <text x="38" y="50"
    style="font-family: var(--font-display); font-size: 23px; fill: var(--ink)">The AI host</text>
  <g style="font-family: var(--font-body); font-size: 14px; fill: var(--ink-soft)">
    <text x="38" y="78">Understands speech, phrases replies</text>
    <text x="38" y="102">Suggests details. Writes nothing.</text>
  </g>

  <!-- The proposal crossing the boundary, and the engine's answer crossing back. -->
  <g style="stroke: currentColor; stroke-width: 1.5">
    <line x1="210" y1="126" x2="210" y2="196" />
    <line x1="300" y1="206" x2="300" y2="136" />
  </g>
  <g style="fill: currentColor">
    <path d="M 204 196 L 216 196 L 210 206 Z" />
    <path d="M 294 136 L 306 136 L 300 126 Z" />
  </g>
  <g style="font-family: var(--font-body); font-size: 13px; fill: var(--ink)">
    <text x="218" y="144">proposes</text>
    <text x="218" y="182">accepts</text>
    <text x="218" y="196">or rejects</text>
  </g>

  <!-- The line itself (plan §7.4). Drawn twice: it is a boundary, not a divider. -->
  <g style="stroke: var(--accent); stroke-width: 1.5">
    <line x1="6" y1="158" x2="334" y2="158" />
    <line x1="6" y1="163" x2="334" y2="163" />
  </g>
  <g style="font-family: var(--font-body); font-size: 11px; letter-spacing: 1.5px">
    <text x="6" y="148" style="fill: var(--ink-soft)">THE AI SUGGESTS</text>
    <text x="6" y="182" style="fill: var(--accent)">THE CODE DECIDES</text>
  </g>

  <!-- Below the line: the booking engine. Filled, because it is the load-bearing half. -->
  <rect x="20" y="210" width="300" height="168" rx="2"
    style="fill: var(--paper-deep); stroke: var(--accent); stroke-width: 1.5" />
  <text x="38" y="246"
    style="font-family: var(--font-display); font-size: 23px; fill: var(--ink)">The booking engine</text>
  <text x="38" y="270"
    style="font-family: var(--font-body); font-size: 13px; fill: var(--ink-soft)">Plain code. No AI. Fully tested.</text>
  <g style="fill: var(--accent)">
    <rect x="38" y="295" width="6" height="6" />
    <rect x="38" y="321" width="6" height="6" />
    <rect x="38" y="347" width="6" height="6" />
  </g>
  <g style="font-family: var(--font-body); font-size: 14px; fill: var(--ink)">
    <text x="54" y="302">Checks every detail it is given</text>
    <text x="54" y="328">Checks whether a table is free</text>
    <text x="54" y="354">Writes the booking. Only it can.</text>
  </g>

  <!-- The fallback: the engine handing the conversation back to itself. -->
  <path d="M 20 358 H 8 V 240 H 14"
    style="fill: none; stroke: var(--ok); stroke-width: 1.5; stroke-dasharray: 5 4" />
  <path d="M 14 234 L 24 240 L 14 246 Z" style="fill: var(--ok)" />
  <g style="font-family: var(--font-body); font-size: 14px; fill: var(--ok)">
    <text x="6" y="404">Fallback — when the AI is unavailable,</text>
    <text x="6" y="426">the engine runs the conversation alone.</text>
  </g>
</svg>`;

/** GitHub blob URLs, built from the one place the repository is named. */
const DOCS_BASE = `${PUBLIC_CONFIG.repositoryUrl}/blob/main/docs/`;

interface Decision {
  readonly title: string;
  readonly body: string;
  readonly linkText: string;
  readonly doc: string;
}

/** Plan §6 names these three, in this order. */
const DECISIONS: readonly Decision[] = [
  {
    title: 'The AI suggests, the code decides',
    body:
      'The model proposes a date, a time and a party size; a dependency-free engine re-checks each one ' +
      'against the real seating plan and is the only part that can write a booking. Tests that deliberately ' +
      'try to talk the engine past its own rules ship with the code.',
    linkText: 'Read where the boundary is',
    doc: 'ai-boundary.md',
  },
  {
    title: "It works when the AI doesn't",
    body:
      "When the gateway is unreachable, or the day's free allowance is gone, a rule brain finishes the " +
      'conversation with no network at all. An automated test blocks the backend entirely and still books a table.',
    linkText: 'Read how it degrades',
    doc: 'degradation.md',
  },
  {
    title: "It can't cost anything",
    body:
      'Every provider key sits in one small worker that enforces per-session, per-address and daily ceilings, ' +
      'and no account behind it has a paid plan. When a ceiling is reached the site keeps working, locally.',
    linkText: 'Read the architecture',
    doc: 'architecture.md',
  },
];

/**
 * Honest, on the page, in the visitor's way (plan §6, §25 item 9).
 *
 * Written out here rather than linked because a limitations list that lives in
 * the README is a limitations list nobody reads.
 */
const LIMITATIONS: readonly string[] = [
  'English only, in two accents: American and Indian. No other languages.',
  'One restaurant, one location. Ember & Oak is fictional and every booking in the diary is made up.',
  'You can book by voice, but you cannot cancel or change a booking by voice.',
  "Speech recognition is the browser's own, so accuracy varies with the browser, the microphone and the room.",
  "The AI runs on free tiers that rate-limit. When the day's allowance is gone, the engine takes the conversation on its own.",
  'Talking over the agent is detected from loudness rather than by a speech model, so a noisy room can trigger it early.',
  'This is a portfolio demo, not production software.',
];

function decisionCard(decision: Decision): HTMLElement {
  return el('li', {
    className: 'how-it-works__card',
    children: [
      el('h3', { className: 'how-it-works__card-title', text: decision.title }),
      el('p', { className: 'how-it-works__card-body', text: decision.body }),
      el('a', {
        className: 'how-it-works__card-link',
        text: decision.linkText,
        attrs: { href: DOCS_BASE + decision.doc, rel: 'noopener' },
      }),
    ],
  });
}

function figure(): HTMLElement {
  const holder = el('div', { className: 'how-it-works__diagram-holder' });
  // The one audited exception. See the note at the top of this file.
  holder.innerHTML = DIAGRAM_SVG;

  return el('figure', {
    className: 'how-it-works__figure',
    children: [
      holder,
      el('figcaption', {
        className: 'how-it-works__caption small',
        children: [
          el('span', { text: 'Above the line the model suggests; below it, plain code decides. ' }),
          el('a', {
            className: 'how-it-works__source',
            text: 'Source on GitHub',
            attrs: { href: PUBLIC_CONFIG.repositoryUrl, rel: 'noopener' },
          }),
        ],
      }),
    ],
  });
}

/**
 * The explanation, in three beats: the AI understands you, the code checks and
 * decides, and the code carries on alone when the AI is gone (plan §25 item 7).
 *
 * Word count: 150, against a ceiling of 200. Counted as whitespace-separated
 * tokens containing at least one letter or digit — the same rule the unit test
 * applies, so the two cannot drift apart.
 */
function explanation(): HTMLElement {
  return el('div', {
    className: 'how-it-works__explanation',
    children: [
      el('p', {
        className: 'prose',
        text:
          'Press the button and speak. What you say goes to a language model that is good at two things: ' +
          'working out what you meant when you did not say it precisely, and answering like a person rather ' +
          'than a form. It suggests a date, a time, a number of people.',
      }),
      el('p', {
        className: 'prose',
        text:
          'Everything it suggests crosses the line in the diagram. Below the line is ordinary code with no ' +
          'model in it: it re-reads every detail, checks the seating plan and the opening hours, and either ' +
          'accepts the suggestion or refuses it with a reason. Only that code can write a booking down, so a ' +
          'confident wrong answer stays a suggestion.',
      }),
      el('p', {
        className: 'prose',
        text:
          'If the model is slow, out of free requests, or unreachable, the same code carries the conversation ' +
          'on its own: reading the date you gave, holding the table, confirming by reading it back. It is less ' +
          'chatty, and it still books your table.',
      }),
    ],
  });
}

export function createHowItWorks(): Component<void> {
  const problem = el('div', {
    className: 'how-it-works__problem',
    children: [
      el('h2', { className: 'section-title', text: 'Why this exists' }),
      el('p', {
        className: 'lede',
        // The restaurant's voice, not a pitch deck's — and no statistic, because
        // no figure in this project appears without a source (plan §3).
        text:
          'The phone rings hardest in the middle of service, when everyone is carrying plates. Someone leaves ' +
          'the pass to answer it, or nobody does and the caller books somewhere else. After we close the line ' +
          'goes to voicemail, and hardly anyone leaves one.',
      }),
    ],
  });

  const how = el('div', {
    className: 'how-it-works__how',
    children: [
      el('h2', { className: 'section-title', attrs: { id: 'hiw-heading' }, text: 'How this works' }),
      figure(),
      explanation(),
    ],
  });

  const decisions = el('div', {
    className: 'how-it-works__decisions',
    children: [
      el('h2', { className: 'section-title', text: 'Key engineering decisions' }),
      el('ul', {
        className: 'how-it-works__cards',
        children: DECISIONS.map(decisionCard),
      }),
    ],
  });

  const limitations = el('aside', {
    className: 'how-it-works__limits',
    attrs: { 'aria-labelledby': 'hiw-limits-heading' },
    children: [
      el('h2', {
        className: 'how-it-works__limits-title',
        attrs: { id: 'hiw-limits-heading' },
        text: 'Limitations',
      }),
      el('ul', {
        className: 'how-it-works__limits-list',
        children: LIMITATIONS.map((text) => el('li', { className: 'how-it-works__limit', text })),
      }),
    ],
  });

  const root = el('section', {
    className: 'how-it-works',
    // Labelled by the heading a visitor would name this section by, which is
    // the second one rather than the first.
    attrs: { 'aria-labelledby': 'hiw-heading' },
    children: [problem, how, decisions, limitations],
  });

  return {
    el: root,
    // Nothing here depends on state; the section is the same on every render.
    update(): void {},
  };
}
