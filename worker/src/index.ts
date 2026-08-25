/**
 * The gateway router (T-060).
 *
 * Five routes. `/health` and `/session` are open; the three proxies require a
 * signed session token. CORS is locked to the Pages origin and localhost — not
 * because that is a real defence (an attacker sets any Origin header they
 * like), but because it stops the gateway being casually embedded in someone
 * else's page. **The quota caps are the actual control**, and plan §13 says so
 * rather than pretending otherwise.
 *
 * Everything here is arranged so that a failure degrades. A request that cannot
 * be served returns a defined error code, the client maps it to a row in plan
 * §7.5, and the visitor gets the rule brain instead of a broken page.
 */

import type { Env, SessionClaims } from './types.js';
import { bearerFrom, handleSession, jsonError, verifyToken } from './session.js';
import { currentMode, flushDailyCount, killSwitchOn, withinSessionRate } from './quota.js';
import { handleHealth } from './health.js';
import { handleChat } from './chat.js';
import { handleSpeak } from './speak.js';
import { handleListen } from './listen.js';

const LOCAL_ORIGINS = ['http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173'];

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin');
  if (origin === null) return null;
  if (origin === env.ALLOWED_ORIGIN) return origin;
  if (LOCAL_ORIGINS.includes(origin)) return origin;
  return null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (origin === null) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Authenticate a request, or produce the response that explains why not.
 *
 * The `401`s here all map to the same client behaviour — drop to rule mode for
 * this turn and try to get a fresh session — so they are deliberately not
 * distinguished for the caller beyond the code.
 */
async function authenticate(
  request: Request,
  env: Env,
  nowSeconds: number,
): Promise<{ claims: SessionClaims } | { response: Response }> {
  const token = bearerFrom(request);
  if (token === null) {
    return { response: jsonError(401, 'A session token is required.', 'no_session', false) };
  }

  const result = await verifyToken(token, env.SESSION_SECRET, nowSeconds);
  if (!result.ok) {
    const retryable = result.reason === 'expired';
    return { response: jsonError(401, 'Session token rejected.', `session_${result.reason}`, retryable) };
  }

  if (!(await withinSessionRate(env, result.claims.sid))) {
    return { response: jsonError(429, 'Slow down a moment.', 'session_rate_limited', true) };
  }

  return { claims: result.claims };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = allowedOrigin(request, env);
    const url = new URL(request.url);
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // `/health` is deliberately open and cacheable: the client polls it before
    // it has a session, precisely to find out whether getting one is worth it.
    if (url.pathname === '/health') {
      return withCors(await handleHealth(env, nowSeconds), origin);
    }

    if (origin === null && request.headers.get('Origin') !== null) {
      return withCors(jsonError(403, 'Origin not allowed.', 'bad_origin', false), null);
    }

    if (url.pathname === '/session') {
      if (request.method !== 'POST') return withCors(methodNotAllowed(), origin);
      return withCors(await handleSession(request, env, nowSeconds), origin);
    }

    const isProxy = url.pathname === '/chat' || url.pathname === '/speak' || url.pathname === '/listen';
    if (!isProxy) {
      return withCors(jsonError(404, 'No such endpoint.', 'not_found', false), origin);
    }
    if (request.method !== 'POST') return withCors(methodNotAllowed(), origin);

    // The owner's off switch, checked before anything is spent. A `degraded`
    // response is not an error — the client silently uses the rule brain (R-37).
    if (await killSwitchOn(env, nowMs)) {
      return withCors(
        jsonError(503, 'Running in simple mode today.', 'degraded_kill_switch', false),
        origin,
      );
    }

    const auth = await authenticate(request, env, nowSeconds);
    if ('response' in auth) return withCors(auth.response, origin);

    // The daily counter is flushed outside the request's critical path so a
    // slow KV write never shows up as reply latency.
    ctx.waitUntil(flushDailyCount(env, nowMs));

    try {
      switch (url.pathname) {
        case '/chat':
          return withCors(await handleChat(request, env, ctx, auth.claims), origin);
        case '/speak':
          return withCors(await handleSpeak(request, env, auth.claims), origin);
        case '/listen':
          return withCors(await handleListen(request, env, auth.claims), origin);
        default:
          return withCors(jsonError(404, 'No such endpoint.', 'not_found', false), origin);
      }
    } catch {
      // An unexpected failure is still a defined degradation: the client reads
      // 503 as "use the rule brain for this turn" and the visitor sees nothing.
      return withCors(jsonError(503, 'Upstream unavailable.', 'upstream_error', true), origin);
    }
  },
};

function methodNotAllowed(): Response {
  return jsonError(405, 'Method not allowed.', 'method_not_allowed', false);
}

export { currentMode };
