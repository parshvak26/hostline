/**
 * Live regions and focus management (T-108).
 *
 * A voice interface has an obvious accessibility trap: everything important is
 * announced by sound, and a screen-reader user is already listening to
 * something. So the rules here are stricter than the usual "add an aria-live and
 * move on":
 *
 *   - **The transcript is polite and announced exactly once.** A `role="log"`
 *     region that re-reads itself on every update is worse than no region.
 *   - **Slot changes go to a separate, throttled region.** "Time confirmed,
 *     7pm" is worth interrupting for; five of them in a second is not.
 *   - **Focus is never stolen mid-conversation.** It moves exactly once, to the
 *     confirmation card when a booking completes, and is handed back afterwards
 *     (plan §14).
 *
 * Nothing here uses `innerHTML`; every string reaching the DOM does so through
 * `textContent`, which is both the security rule (plan §13) and the reason a
 * visitor's name can be announced without a second thought.
 */

const ANNOUNCE_THROTTLE_MS = 400;

export interface LiveRegions {
  /** Agent turns and visitor turns, announced once each, politely. */
  log(text: string): void;
  /** Slot confirmations and mode changes. Assertive but rate-limited. */
  announce(text: string): void;
  /** Errors: what happened, then what to do, in that order (plan §5.4). */
  error(text: string): void;
  destroy(): void;
}

function makeRegion(id: string, live: 'polite' | 'assertive', role?: string): HTMLElement {
  const existing = document.getElementById(id);
  if (existing !== null) return existing;

  const region = document.createElement('div');
  region.id = id;
  region.className = 'visually-hidden';
  region.setAttribute('aria-live', live);
  region.setAttribute('aria-atomic', 'true');
  if (role !== undefined) region.setAttribute('role', role);
  document.body.append(region);
  return region;
}

export function createLiveRegions(): LiveRegions {
  const logRegion = makeRegion('live-log', 'polite', 'log');
  const statusRegion = makeRegion('live-status', 'assertive', 'status');
  const errorRegion = makeRegion('live-error', 'assertive', 'alert');

  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Coalesce a burst into one announcement.
   *
   * Committing a booking confirms five slots at once. Five separate assertive
   * announcements would interrupt each other and the visitor would hear the
   * last one; one sentence gets them all across.
   */
  const flush = (): void => {
    timer = null;
    if (pending.length === 0) return;
    statusRegion.textContent = pending.join('. ');
    pending = [];
  };

  return {
    log(text: string): void {
      if (text.trim() === '') return;
      logRegion.textContent = text;
    },

    announce(text: string): void {
      if (text.trim() === '') return;
      pending.push(text);
      if (timer === null) timer = setTimeout(flush, ANNOUNCE_THROTTLE_MS);
    },

    error(text: string): void {
      errorRegion.textContent = text;
    },

    destroy(): void {
      if (timer !== null) clearTimeout(timer);
      logRegion.remove();
      statusRegion.remove();
      errorRegion.remove();
    },
  };
}

/* ----------------------------------------------------------------- focus -- */

/**
 * Move focus somewhere and remember where it came from.
 *
 * Used once per conversation, when the booking completes. Anything more
 * frequent than that is focus theft, and a visitor who has been moved
 * unexpectedly mid-sentence has lost their place in a way sighted users do not
 * experience.
 */
export function moveFocusTo(element: HTMLElement): () => void {
  const previous = document.activeElement;

  if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');
  element.focus({ preventScroll: false });

  return (): void => {
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  };
}

/** True when the visitor has asked for less movement (plan §14). */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * `Esc` interrupts the agent — the keyboard equivalent of talking over it.
 *
 * Barge-in must not require a microphone or a mouse. Returns an unsubscribe.
 */
export function onEscape(handler: () => void): () => void {
  const listener = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') handler();
  };
  document.addEventListener('keydown', listener);
  return () => document.removeEventListener('keydown', listener);
}

/* ------------------------------------------------------------ small DOM -- */

/**
 * Create an element with text and attributes, safely.
 *
 * Exists so that no component ever has a reason to reach for `innerHTML`, which
 * is banned by lint. Text always goes through `textContent`.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    attrs?: Record<string, string>;
    children?: readonly Node[];
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className !== undefined) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [key, value] of Object.entries(options.attrs ?? {})) node.setAttribute(key, value);
  for (const child of options.children ?? []) node.append(child);
  return node;
}

/** Remove every child. `replaceChildren` with no arguments, named for intent. */
export function clear(node: Element): void {
  node.replaceChildren();
}
