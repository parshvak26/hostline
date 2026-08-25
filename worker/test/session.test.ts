/**
 * Session tokens and Turnstile (T-061).
 *
 * These are the two things standing between a public gateway and someone's
 * script draining the day's free allowance. The interesting tests are not the
 * happy paths — they are the tamper cases, because a token that can be edited
 * is a quota that can be raised.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  bearerFrom,
  claimsFor,
  handleSession,
  issueToken,
  newSessionId,
  verifyToken,
  verifyTurnstile,
} from '../src/session.js';
import { resetIsolateState } from '../src/quota.js';
import type { SessionClaims } from '../src/types.js';
import { DEFAULT_QUOTA, SESSION_TTL_SECONDS } from '../src/types.js';

const SECRET = 'test-secret-not-a-real-one';
const NOW = 1_800_000_000;

function claims(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return { sid: 'sid-1', iat: NOW, exp: NOW + SESSION_TTL_SECONDS, quota: DEFAULT_QUOTA, ...overrides };
}

beforeEach(() => {
  resetIsolateState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------------------------------------------------------- tokens -- */

describe('session tokens', () => {
  it('round-trips a valid token', async () => {
    const token = await issueToken(claims(), SECRET);
    const result = await verifyToken(token, SECRET, NOW + 60);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.sid).toBe('sid-1');
    expect(result.claims.quota.turns).toBe(DEFAULT_QUOTA.turns);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await issueToken(claims(), 'someone-elses-secret');
    const result = await verifyToken(token, SECRET, NOW + 60);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('bad_signature');
  });

  it('rejects a token whose payload was edited to raise its own quota', async () => {
    // The attack this design exists to stop: take a legitimate token, rewrite
    // the quota, send it back. The signature covers the payload, so it fails
    // before anything reads the numbers.
    const token = await issueToken(claims(), SECRET);
    const [payload, signature] = token.split('.');
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();

    const decoded = atob((payload ?? '').replace(/-/g, '+').replace(/_/g, '/'));
    const tampered = decoded.replace('"turns":12', '"turns":9999');
    const repacked = btoa(tampered).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const result = await verifyToken(`${repacked}.${signature ?? ''}`, SECRET, NOW + 60);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('bad_signature');
  });

  it('rejects an expired token', async () => {
    const token = await issueToken(claims(), SECRET);
    const result = await verifyToken(token, SECRET, NOW + SESSION_TTL_SECONDS + 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('expired');
  });

  it('accepts a token one second before it expires', async () => {
    const token = await issueToken(claims(), SECRET);
    const result = await verifyToken(token, SECRET, NOW + SESSION_TTL_SECONDS - 1);
    expect(result.ok).toBe(true);
  });

  it('rejects malformed tokens without throwing', async () => {
    const nonsense = [
      '',
      'no-dot',
      'a.b.c',
      '.',
      'nope.nope',
      `${'x'.repeat(5000)}.${'y'.repeat(5000)}`,
      'eyJhIjoxfQ.',
      '.signature',
    ];

    for (const token of nonsense) {
      const result = await verifyToken(token, SECRET, NOW);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a well-signed token whose payload is not a claims object', async () => {
    // Signed by us, so the signature passes — the shape check is what catches
    // it. Worth its own test because it is the case a signature-only guard
    // would wave through.
    const encoder = new TextEncoder();
    const payloadBytes = encoder.encode(JSON.stringify({ hello: 'world' }));
    let binary = '';
    for (const byte of payloadBytes) binary += String.fromCharCode(byte);
    const payload = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
    let sigBinary = '';
    for (const byte of sig) sigBinary += String.fromCharCode(byte);
    const signature = btoa(sigBinary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const result = await verifyToken(`${payload}.${signature}`, SECRET, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed');
  });

  it('issues distinct session ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSessionId()));
    expect(ids.size).toBe(200);
  });

  it('gives every session a twenty-minute life', () => {
    const issued = claimsFor(NOW);
    expect(issued.exp - issued.iat).toBe(SESSION_TTL_SECONDS);
  });
});

/* --------------------------------------------------------------- bearers -- */

describe('bearerFrom', () => {
  it('reads a bearer token, case-insensitively', () => {
    expect(bearerFrom(new Request('https://x/', { headers: { Authorization: 'Bearer abc.def' } }))).toBe('abc.def');
    expect(bearerFrom(new Request('https://x/', { headers: { Authorization: 'bearer abc.def' } }))).toBe('abc.def');
  });

  it('returns null for anything else', () => {
    expect(bearerFrom(new Request('https://x/'))).toBeNull();
    expect(bearerFrom(new Request('https://x/', { headers: { Authorization: 'Basic abc' } }))).toBeNull();
    expect(bearerFrom(new Request('https://x/', { headers: { Authorization: 'Bearer' } }))).toBeNull();
  });
});

/* ------------------------------------------------------------- turnstile -- */

describe('Turnstile verification', () => {
  it('passes when Cloudflare says the token is good', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const result = await verifyTurnstile('token', 'secret', '203.0.113.1');
    expect(result.success).toBe(true);
  });

  it('fails closed when Cloudflare says no', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] })),
    );
    const result = await verifyTurnstile('token', 'secret', null);
    expect(result.success).toBe(false);
    expect(result.reason).toContain('invalid-input-response');
  });

  it('fails closed when the verification endpoint is unreachable', async () => {
    // The important direction. Being wrong strictly costs one visitor a
    // fallback to rule mode, which is a complete experience. Being wrong
    // leniently is an open door onto the day's allowance.
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down');
    });
    const result = await verifyTurnstile('token', 'secret', null);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('verify_unreachable');
  });

  it('fails closed on a non-200 from the verification endpoint', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const result = await verifyTurnstile('token', 'secret', null);
    expect(result.success).toBe(false);
  });

  it('sends the visitor IP when there is one', async () => {
    let sentIp: unknown = null;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = init?.body;
      if (body instanceof FormData) sentIp = body.get('remoteip');
      return new Response(JSON.stringify({ success: true }));
    });

    await verifyTurnstile('token', 'secret', '203.0.113.9');
    expect(sentIp).toBe('203.0.113.9');
  });
});

/* -------------------------------------------------------- POST /session -- */

describe('POST /session', () => {
  const post = (body: unknown, headers: Record<string, string> = {}): Request =>
    new Request('https://gateway.test/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('issues a usable token for a verified human', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: true })));

    const response = await handleSession(post({ turnstileToken: 'good' }), env, NOW);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { token: string; expiresAt: number; mode: string; quota: unknown };
    expect(body.mode).toBe('full');
    expect(body.expiresAt).toBeGreaterThan(NOW * 1000);

    const verified = await verifyToken(body.token, env.SESSION_SECRET, NOW + 1);
    expect(verified.ok).toBe(true);
  });

  it('refuses a request with no Turnstile token', async () => {
    const response = await handleSession(post({}), env, NOW);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('missing_turnstile');
  });

  it('refuses an unreadable body', async () => {
    const response = await handleSession(post('not json at all'), env, NOW);
    expect(response.status).toBe(400);
  });

  it('refuses when Turnstile rejects the token', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: false, 'error-codes': ['bad'] })));

    const response = await handleSession(post({ turnstileToken: 'forged' }), env, NOW);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('turnstile_failed');
  });

  it('never returns a secret in the response', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: true })));

    const response = await handleSession(post({ turnstileToken: 'good' }), env, NOW);
    const text = await response.clone().text();

    expect(text).not.toContain(env.SESSION_SECRET);
    expect(text).not.toContain(env.TURNSTILE_SECRET);
    expect(text).not.toContain(env.MODEL_API_KEY);
    for (const [, value] of response.headers) {
      expect(value).not.toContain(env.SESSION_SECRET);
    }
  });

  it('reports degraded mode without failing, when the kill switch is on', async () => {
    // A visitor arriving on a killed day gets a working session and the rule
    // brain, not an error (R-37, R-38).
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: true })));
    await env.STATE.put('kill_switch', 'on');
    resetIsolateState();

    const response = await handleSession(post({ turnstileToken: 'good' }), env, NOW);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mode: string };
    expect(body.mode).toBe('degraded');

    await env.STATE.delete('kill_switch');
    resetIsolateState();
  });
});
