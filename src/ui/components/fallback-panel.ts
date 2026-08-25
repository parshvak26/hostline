/**
 * The catastrophic fallback panel (T-110, plan §7.5 F12).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE MUST NOT BE ABLE TO FAIL.
 *
 * It runs after `window.onerror` has already fired, which means something else
 * in the application is broken and the visitor is one more thrown exception
 * away from a blank page. F12 is the floor, and a floor with a hole in it is
 * not a floor. The rules below are the design, not stylistic preference:
 *
 *   1. **No component imports.** Nothing from `./component.js`, nothing from
 *      `../a11y.js`, no shared helpers. A helper that throws takes the panel
 *      with it, and the whole point of this module is that it survives whatever
 *      killed the rest of the page.
 *   2. **Plain `document.createElement` and `textContent`.** No `innerHTML`, no
 *      templating, no cleverness. Two DOM calls that have worked in every
 *      browser since 2005.
 *   3. **The text is built and attached first.** Heading and message land in
 *      the panel before anything riskier is attempted, so that a failure in the
 *      media element or the URL still leaves a readable apology on screen.
 *   4. **Everything that can throw is wrapped.** The media element and the
 *      repository URL each get their own `try`/`catch`; neither can take the
 *      other down, and neither can take the text down.
 *   5. **No optional chaining onto anything unverified.** A `typeof` guard says
 *      what is actually being assumed; `?.` hides it.
 *
 * The recording (R-56) covers the visitor whose browser cannot run the demo at
 * all. It has not been produced yet, so the player is treated as optional in
 * both directions: absent codec support and a missing file both end with the
 * player removed and the text intact, never with a broken control strip.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { PUBLIC_CONFIG } from '../../config/settings.js';
import type { Component } from './component.js';

import '../styles/components/fallback-panel.css';

export interface FallbackProps {
  /** Overrides the default line. Anything falsy leaves the default in place. */
  readonly message?: string;
}

/** Plan §5.4: what happened, then what to do, in that order, in one sentence. */
const DEFAULT_MESSAGE =
  'The demo hit an unexpected error and stopped; reload the page to start again, or use the links below.';

const RECORDING_SRC = './demo/conversation.webm';
const RECORDING_TYPE = 'video/webm';
const CAPTIONS_SRC = './demo/conversation.vtt';

let instanceCount = 0;

export function createFallbackPanel(options: { repositoryUrl?: string } = {}): Component<FallbackProps> {
  instanceCount += 1;
  const titleId = `fallback-title-${String(instanceCount)}`;

  const root = document.createElement('div');
  root.className = 'fallback-panel';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-labelledby', titleId);

  const title = document.createElement('h2');
  title.className = 'fallback-panel__title display';
  title.id = titleId;
  title.textContent = 'The demo stopped';

  const message = document.createElement('p');
  message.className = 'fallback-panel__message';
  message.textContent = DEFAULT_MESSAGE;

  // Rule 3: the text is on screen before anything that could throw is tried.
  root.append(title, message);

  // Deliberately *not* built here.
  //
  // The panel is constructed on every page load so that it is already in the
  // document if something later goes wrong — but it is hidden, and a hidden
  // panel must cost nothing. Building the player eagerly fetches the caption
  // track on every healthy visit, which is a 404 in the console of a page where
  // nothing is wrong. It is built the first time the panel is actually shown.
  let recordingAdded = false;
  addLinks(root, options.repositoryUrl);

  return {
    el: root,
    update(props: FallbackProps): void {
      if (!recordingAdded) {
        recordingAdded = true;
        addRecording(root);
      }

      const next = props.message;
      // A caller passing an empty string is a caller with no useful detail, not
      // a caller asking for a blank panel.
      if (typeof next === 'string' && next.trim() !== '') message.textContent = next;
      else message.textContent = DEFAULT_MESSAGE;
    },
  };
}

/**
 * The recording, if this browser can play it and the file turns out to exist.
 *
 * Two separate failures to survive. Codec support is knowable up front, so it
 * is checked before anything is inserted. A missing file is not knowable until
 * the network answers, so the `error` handler removes the whole figure rather
 * than leaving a dead control strip sitting under an apology.
 *
 * Called on first reveal, never on construction — see the note in the factory.
 */
function addRecording(root: HTMLElement): void {
  try {
    if (typeof HTMLVideoElement === 'undefined') return;

    const video = document.createElement('video');
    if (typeof video.canPlayType !== 'function') return;
    if (video.canPlayType(RECORDING_TYPE) === '') return;

    video.className = 'fallback-panel__player';
    video.controls = true;
    video.preload = 'metadata';
    video.setAttribute('playsinline', '');

    const source = document.createElement('source');
    source.src = RECORDING_SRC;
    source.type = RECORDING_TYPE;
    video.append(source);

    // Captions are part of the recording deliverable, not a separate one. A
    // missing `.vtt` costs nothing: the browser drops the track and the video
    // still plays.
    const track = document.createElement('track');
    track.kind = 'captions';
    track.src = CAPTIONS_SRC;
    track.srclang = 'en';
    track.label = 'English';
    track.default = true;
    video.append(track);

    const caption = document.createElement('figcaption');
    caption.className = 'fallback-panel__caption';
    caption.textContent = 'A recording of the same conversation, in case the demo will not run here.';

    const figure = document.createElement('figure');
    figure.className = 'fallback-panel__figure';
    figure.append(video, caption);

    // Media `error` events do not bubble, so both elements are listened to
    // directly. Whichever fires first wins; `remove()` on a detached node is a
    // no-op, so a second firing is harmless.
    const drop = (): void => {
      try {
        figure.remove();
      } catch {
        // Nothing left to do. The text above is what matters and it is already
        // on screen.
      }
    };
    video.addEventListener('error', drop);
    source.addEventListener('error', drop);

    root.append(figure);
  } catch {
    // A browser that cannot build a video element still gets the apology and
    // the links.
  }
}

/**
 * The repository link, and the reload instruction beside it.
 *
 * The URL is validated rather than trusted: `createFallbackPanel` is called
 * from an error handler, and an error handler is exactly where a caller is
 * least likely to have checked what it is passing.
 */
function addLinks(root: HTMLElement, supplied: string | undefined): void {
  try {
    const href = safeRepositoryUrl(supplied);
    if (href === '') return;

    const link = document.createElement('a');
    link.className = 'fallback-panel__link';
    link.href = href;
    link.rel = 'noopener noreferrer';
    link.textContent = 'Read the source on GitHub';

    const links = document.createElement('p');
    links.className = 'fallback-panel__links';
    links.append(link);

    root.append(links);
  } catch {
    // The text stands on its own.
  }
}

function safeRepositoryUrl(supplied: string | undefined): string {
  let candidate = '';
  try {
    candidate = typeof supplied === 'string' && supplied.trim() !== '' ? supplied.trim() : PUBLIC_CONFIG.repositoryUrl;
  } catch {
    return '';
  }

  try {
    // `new URL` is the cheapest way to refuse a `javascript:` href without
    // hand-rolling a scheme parser, and it throws on anything malformed.
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.href;
  } catch {
    return '';
  }
}
