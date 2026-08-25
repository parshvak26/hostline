/**
 * Turnstile verification and session tokens (T-061).
 *
 * Two jobs:
 *
 *   1. Prove a human started this conversation, so a script cannot drain the
 *      day's free allowance in a loop (R-36).
 *   2. Hand back a short-lived, signed token that carries the session's quota,
 *      so every later request can be attributed and counted without a database.
 *
 * The token is an HMAC-SHA256 over a compact JSON payload — about thirty lines
 * of Web Crypto rather than a JWT library, because the only claims that exist
 * are the four in {@link SessionClaims} and a dependency to parse them would be
 * more surface than value.
 *
 * **The quota inside the token is a display convenience, not a control.** The
 * browser is told what it may spend so the UI can be honest about it; the
 * server re-checks the same limits on every request, because the browser is
 * untrusted (plan §7.4, rule 2).
 */

import type { Env, SessionClaims, SessionQuota } from './types.js';
import { DEFAULT_QUOTA, SESSION_TTL_SECONDS } from './types.js';

const encoder = new TextEncoder();

/* ------------------------------------------------------------- encoding -- */

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/**
 * Constant-time comparison.
 *
 * `crypto.subtle.verify` already is, and it is what actually guards the token.
 * This exists for the places where two strings are compared directly.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* --------------------------------------------------------------- tokens -- */

export async function issueToken(claims: SessionClaims, secret: string): Promise<string> {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export type TokenFailure = 'malformed' | 'bad_signature' | 'expired';

export type TokenResult =
  | { readonly ok: true; readonly claims: SessionClaims }
  | { readonly ok: false; readonly reason: TokenFailure };

/**
 * Verify a token.
 *
 * Signature first, then expiry, then shape. Checking the signature before
 * parsing means a tampered payload is never handed to `JSON.parse`, let alone
 * trusted — the model of "verify, then look" rather than "look, then verify".
 */
export async function verifyToken(token: string, secret: string, nowSeconds: number): Promise<TokenResult> {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payload, signature] = parts;
  if (payload === undefined || signature === undefined || payload === '' || signature === '') {
    return { ok: false, reason: 'malformed' };
  }

  let valid = false;
  try {
    const key = await hmacKey(secret);
    valid = await crypto.subtle.verify('HMAC', key, base64UrlDecode(signature), encoder.encode(payload));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  let claims: SessionClaims;
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(payload)) as string;
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'malformed' };
    const record = parsed as Record<string, unknown>;
    const quota = record['quota'];
    if (
      typeof record['sid'] !== 'string' ||
      typeof record['iat'] !== 'number' ||
      typeof record['exp'] !== 'number' ||
      typeof quota !== 'object' ||
      quota === null
    ) {
      return { ok: false, reason: 'malformed' };
    }
    claims = parsed as unknown as SessionClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (claims.exp <= nowSeconds) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

/** Pull the bearer token out of a request, or null. */
export function bearerFrom(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/* ------------------------------------------------------------ turnstile -- */

export interface TurnstileResult {
  readonly success: boolean;
  readonly reason?: string;
}

/**
 * Verify a Turnstile token with Cloudflare.
 *
 * A network failure here is treated as a **failure**, not a pass. The cost of
 * being wrong in the strict direction is one visitor falling back to rule mode,
 * which is a fully working experience. The cost of being wrong in the lenient
 * direction is an open door onto the day's free allowance.
 */
export async function verifyTurnstile(
  token: string,
  secret: string,
  remoteIp: string | null,
): Promise<TurnstileResult> {
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (remoteIp !== null) body.append('remoteip', remoteIp);

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    if (!response.ok) return { success: false, reason: `verify_http_${response.status}` };

    const parsed: unknown = await response.json();
    const record = parsed as { success?: unknown; 'error-codes'?: unknown };
    if (record.success === true) return { success: true };

    const codes = Array.isArray(record['error-codes']) ? record['error-codes'].join(',') : 'unknown';
    return { success: false, reason: String(codes) };
  } catch {
    return { success: false, reason: 'verify_unreachable' };
  }
}

/* --------------------------------------------------------------- issuing -- */

export function newSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function claimsFor(nowSeconds: number, quota: SessionQuota = DEFAULT_QUOTA): SessionClaims {
  return {
    sid: newSessionId(),
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
    quota,
  };
}

/**
 * Handle `POST /session`.
 *
 * Any failure here is survivable by design: the client falls back to the rule
 * brain and the browser's own voice for the visit, and the visitor never learns
 * anything went wrong (plan §7.5 F1).
 */
export async function handleSession(request: Request, env: Env, nowSeconds: number): Promise<Response> {
  let turnstileToken = '';
  try {
    const parsed: unknown = await request.json();
    const record = parsed as { turnstileToken?: unknown };
    if (typeof record.turnstileToken === 'string') turnstileToken = record.turnstileToken;
  } catch {
    return jsonError(400, 'Missing or unreadable request body.', 'bad_request', false);
  }

  if (turnstileToken === '') {
    return jsonError(400, 'A Turnstile token is required.', 'missing_turnstile', false);
  }

  const ip = request.headers.get('CF-Connecting-IP');

  // Per-IP session limit, before the Turnstile round-trip, so a flood costs us
  // nothing but a rate-limiter lookup.
  if (env.IP_LIMITER !== undefined && ip !== null) {
    const allowed = await env.IP_LIMITER.limit({ key: `session:${ip}` });
    if (!allowed.success) {
      return jsonError(429, 'Too many sessions from this address.', 'ip_rate_limited', true);
    }
  }

  const verified = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET, ip);
  if (!verified.success) {
    return jsonError(403, 'Could not verify that you are human.', 'turnstile_failed', false);
  }

  const mode = await currentMode(env, nowSeconds);
  const claims = claimsFor(nowSeconds);
  const token = await issueToken(claims, env.SESSION_SECRET);

  return new Response(
    JSON.stringify({
      token,
      expiresAt: claims.exp * 1000,
      mode,
      quota: claims.quota,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Re-exported from quota.ts through here so `index.ts` has one import site. */
import { currentMode } from './quota.js';
export { currentMode, timingSafeEqual };

export function jsonError(status: number, error: string, code: string, retryable: boolean): Response {
  return new Response(JSON.stringify({ error, code, retryable }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
