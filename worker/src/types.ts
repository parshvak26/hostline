/**
 * The gateway's environment and shared shapes.
 *
 * This worker exists for exactly one reason: **a key cannot live in the
 * browser** (R-30). Everything else it does — Turnstile, quotas, the kill
 * switch, the three streaming proxies — follows from having to put the key
 * somewhere, and from the fact that once you have a place to put a key you also
 * have the only place where a spending limit can actually be enforced (R-35).
 *
 * It holds no conversation content. It counts requests and it forwards bytes.
 */

/** Bindings and secrets. Secrets are set with `wrangler secret put`, never here. */
export interface Env {
  /* --- secrets ---------------------------------------------------------- */
  readonly MODEL_API_KEY: string;
  readonly TTS_API_KEY: string;
  readonly STT_API_KEY: string;
  readonly TURNSTILE_SECRET: string;
  /** Signs session tokens. Any long random string. */
  readonly SESSION_SECRET: string;

  /* --- public vars ------------------------------------------------------ */
  readonly ALLOWED_ORIGIN: string;
  readonly DAILY_TURN_CEILING: string;
  readonly KILL_SWITCH: string;
  readonly MODEL_NAME: string;
  readonly TTS_MODEL: string;
  readonly TTS_VOICE: string;
  readonly STT_MODEL: string;

  /* --- bindings --------------------------------------------------------- */
  readonly STATE: KVNamespace;
  readonly SESSION_LIMITER?: RateLimiter;
  readonly IP_LIMITER?: RateLimiter;
}

/** Cloudflare's rate-limiting binding. No KV writes, which is the point. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Everything a session is allowed to spend.
 *
 * Embedded in the signed token so the browser can display it, and re-checked
 * server-side on every request so the browser cannot raise it (plan §7.4).
 */
export interface SessionQuota {
  /** Model turns. Matches `TURN.maxTurns` in the client's settings. */
  readonly turns: number;
  /** Seconds of hosted synthesis. */
  readonly ttsSeconds: number;
  /** Hosted recognition clips. */
  readonly clips: number;
}

export interface SessionClaims {
  /** Session id. Opaque, random, not tied to any identity. */
  readonly sid: string;
  /** Issued at, epoch seconds. */
  readonly iat: number;
  /** Expires at, epoch seconds. */
  readonly exp: number;
  readonly quota: SessionQuota;
}

export type GatewayMode = 'full' | 'degraded';

/** Every error the client can meet maps to a defined degradation in §7.5. */
export interface ErrorBody {
  readonly error: string;
  readonly code: string;
  readonly retryable: boolean;
}

export const DEFAULT_QUOTA: SessionQuota = { turns: 12, ttsSeconds: 90, clips: 25 };

/** Session lifetime. Short enough that a stolen token is worth little. */
export const SESSION_TTL_SECONDS = 20 * 60;

/** Hard byte and length caps, applied before anything reaches a provider. */
export const LIMITS = {
  maxSpeakChars: 240,
  maxListenBytes: 400 * 1024,
  maxChatBodyBytes: 32 * 1024,
  /** Only the last eight turns are forwarded (plan §11). */
  maxHistoryTurns: 8,
  maxOutputTokens: 220,
  maxInputTokens: 800,
  /** Sessions per IP per hour. */
  sessionsPerIpPerHour: 5,
} as const;
