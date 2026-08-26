/**
 * Cloudflare Turnstile, loaded only if it is actually needed (R-36).
 *
 * The gateway will not issue a session without a Turnstile token, and without a
 * session the model and the neural voice are unreachable. So this is the first
 * link in the AI path — and, deliberately, a link that can break without anyone
 * noticing: every failure here resolves to `null`, the session is never issued,
 * and the visitor gets the rule brain and the browser's own voice. Which is a
 * complete experience (plan §7.5 F1).
 *
 * ## Why it is loaded lazily
 *
 * Turnstile's script is the only third-party resource this page can load, and
 * it is loaded **on the first press of the Talk button**, never on page load.
 * Three reasons:
 *
 *   - A build with no gateway configured never loads it at all, so the page has
 *     genuinely zero third-party requests in its default state.
 *   - It stays off the critical path, which is what keeps the first-visit
 *     transfer where it is.
 *   - A bot check that runs before anyone has interacted is a bot check running
 *     against people who are still reading.
 *
 * The widget is rendered invisibly. A visitor who is plainly a person is not
 * asked to prove it.
 */

import { PUBLIC_CONFIG } from '../config/settings.js';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Past this, the challenge is not worth waiting on. Rule mode is fine. */
const TOKEN_TIMEOUT_MS = 6_000;

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  execute(widgetId: string): void;
  remove(widgetId: string): void;
}

function api(): TurnstileApi | null {
  const candidate = (globalThis as { turnstile?: unknown }).turnstile;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const record = candidate as Partial<TurnstileApi>;
  return typeof record.render === 'function' && typeof record.execute === 'function'
    ? (candidate as TurnstileApi)
    : null;
}

let scriptPromise: Promise<boolean> | null = null;

/** Inject the script once. Resolves false rather than throwing. */
function loadScript(): Promise<boolean> {
  if (api() !== null) return Promise.resolve(true);
  if (scriptPromise !== null) return scriptPromise;

  scriptPromise = new Promise<boolean>((resolve) => {
    try {
      const script = document.createElement('script');
      script.src = SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.addEventListener('load', () => resolve(api() !== null), { once: true });
      script.addEventListener('error', () => resolve(false), { once: true });
      document.head.append(script);
    } catch {
      resolve(false);
    }

    // The script can load and still never define the global if it is blocked by
    // an extension. A deadline covers both.
    setTimeout(() => resolve(api() !== null), TOKEN_TIMEOUT_MS);
  });

  return scriptPromise;
}

export function turnstileConfigured(): boolean {
  return PUBLIC_CONFIG.turnstileSiteKey.trim() !== '';
}

/**
 * Obtain a Turnstile token, or `null`.
 *
 * `null` is an ordinary outcome, not an error: no site key configured, script
 * blocked, challenge failed, or simply slow. The caller treats all of them the
 * same way — no session, rule mode, no message to the visitor.
 */
export async function getTurnstileToken(): Promise<string | null> {
  if (!turnstileConfigured()) return null;
  if (!(await loadScript())) return null;

  const turnstile = api();
  if (turnstile === null) return null;

  // Rendered off-screen rather than `display: none`: Turnstile declines to run
  // in a container it considers hidden, and an unrendered widget never produces
  // a token.
  const container = document.createElement('div');
  container.className = 'visually-hidden';
  container.setAttribute('aria-hidden', 'true');
  document.body.append(container);

  return new Promise<string | null>((resolve) => {
    let settled = false;
    let widgetId: string | null = null;

    const finish = (token: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        if (widgetId !== null) turnstile.remove(widgetId);
      } catch {
        // Removing a widget that already went away is not worth reporting.
      }
      container.remove();
      resolve(token);
    };

    const timer = setTimeout(() => finish(null), TOKEN_TIMEOUT_MS);

    try {
      widgetId = turnstile.render(container, {
        sitekey: PUBLIC_CONFIG.turnstileSiteKey,
        // `appearance`, not `size`. Turnstile's sizes are normal, compact and
        // flexible — passing 'invisible' there throws, which is how the AI path
        // silently failed to authenticate on the deployed site. Invisibility is
        // a matter of *when* the widget appears, and `interaction-only` means
        // "only if this visitor actually has to prove something".
        appearance: 'interaction-only',
        callback: (token: string) => {
          clearTimeout(timer);
          finish(typeof token === 'string' && token !== '' ? token : null);
        },
        'error-callback': () => {
          clearTimeout(timer);
          finish(null);
        },
        'timeout-callback': () => {
          clearTimeout(timer);
          finish(null);
        },
      });

      // `execute()` belongs to the `appearance: 'execute'` mode. Under
      // `interaction-only` the widget has already started by the time render
      // returns, so a throw here means "you did not need to ask", not "this
      // failed" — and abandoning a widget that is already working would give up
      // a token we are about to be handed.
      try {
        turnstile.execute(widgetId);
      } catch {
        // Already running.
      }
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}
