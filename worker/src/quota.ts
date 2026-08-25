/**
 * Quotas and the kill switch (T-062).
 *
 * ## The constraint that shaped this file
 *
 * Cloudflare's free KV tier allows roughly **1,000 writes per day** and 100,000
 * reads. A naive per-request counter would spend the entire write budget on a
 * few hundred conversations and then start failing — so the accounting is built
 * around reads being cheap and writes being scarce:
 *
 *   - **Per-IP and per-session limits** use the rate-limiting binding, which
 *     performs no KV operations at all.
 *   - **The global daily ceiling** is counted in-isolate and flushed to KV at
 *     most once every 60 seconds per isolate. Several isolates run at once, so
 *     the count is an **approximation that undercounts**, and the ceiling is set
 *     conservatively (about 60% of the provider's free allowance) to absorb it.
 *   - **The kill switch** is a KV read, cached for 60 seconds per isolate.
 *
 * ## What actually guarantees the bill is zero
 *
 * Not these counters. **No paid plan exists on any account.** When a free tier is
 * exhausted the provider returns 429, the client falls back to the rule brain,
 * and the demo carries on. The counters exist to keep the free tier available
 * for real visitors rather than for a script — they are not the cost control,
 * and `docs/degradation.md` says so in as many words.
 */

import type { Env, GatewayMode, SessionQuota } from './types.js';

/** How long an isolate may trust its cached view of the kill switch and count. */
const CACHE_TTL_MS = 60_000;

const KILL_SWITCH_KEY = 'kill_switch';
const DAILY_PREFIX = 'daily:';

/**
 * Per-isolate state.
 *
 * Module scope, so it lives as long as the isolate does. Several isolates each
 * hold their own copy, which is the source of the undercount described above.
 */
interface IsolateState {
  killSwitch: boolean;
  killSwitchCheckedAt: number;
  /** Turns counted in this isolate since the last flush. */
  pendingTurns: number;
  /** Last value read from KV, plus what we have added since. */
  knownTotal: number;
  totalCheckedAt: number;
  lastFlushAt: number;
  day: string;
}

const state: IsolateState = {
  killSwitch: false,
  killSwitchCheckedAt: 0,
  pendingTurns: 0,
  knownTotal: 0,
  totalCheckedAt: 0,
  lastFlushAt: 0,
  day: '',
};

/** UTC day key. The ceiling resets at midnight UTC, which is stated in the docs. */
export function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Reset between tests, and whenever the day rolls over. */
export function resetIsolateState(): void {
  state.killSwitch = false;
  state.killSwitchCheckedAt = 0;
  state.pendingTurns = 0;
  state.knownTotal = 0;
  state.totalCheckedAt = 0;
  state.lastFlushAt = 0;
  state.day = '';
}

/* ---------------------------------------------------------- kill switch -- */

/**
 * Is the owner's off switch on? (R-37)
 *
 * Two sources: a KV key, which takes effect within 60 seconds without a
 * redeploy, and the `KILL_SWITCH` var, which needs one. The KV key is the live
 * lever; the var is there so a fork with no KV namespace still has a way to
 * stop spending.
 */
export async function killSwitchOn(env: Env, nowMs: number): Promise<boolean> {
  if (env.KILL_SWITCH.trim().toLowerCase() === 'on') return true;

  if (nowMs - state.killSwitchCheckedAt < CACHE_TTL_MS) return state.killSwitch;

  try {
    const value = await env.STATE.get(KILL_SWITCH_KEY);
    state.killSwitch = value !== null && value.trim().toLowerCase() === 'on';
  } catch {
    // A KV read failure must not take the gateway down. Assume off and carry
    // on; the provider's own limits remain the real backstop.
    state.killSwitch = false;
  }
  state.killSwitchCheckedAt = nowMs;
  return state.killSwitch;
}

/* --------------------------------------------------------- daily ceiling -- */

async function readDailyTotal(env: Env, nowMs: number): Promise<number> {
  const today = dayKey(nowMs);
  if (state.day !== today) {
    // Day rolled over: the isolate's pending count belongs to yesterday and is
    // dropped rather than carried forward into the new day's budget.
    state.day = today;
    state.pendingTurns = 0;
    state.knownTotal = 0;
    state.totalCheckedAt = 0;
  }

  if (nowMs - state.totalCheckedAt < CACHE_TTL_MS) return state.knownTotal + state.pendingTurns;

  try {
    const raw = await env.STATE.get(`${DAILY_PREFIX}${today}`);
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    state.knownTotal = Number.isFinite(parsed) ? parsed : 0;
  } catch {
    // Unreadable counter: trust what this isolate has seen rather than
    // pretending the day is empty.
  }
  state.totalCheckedAt = nowMs;
  return state.knownTotal + state.pendingTurns;
}

/**
 * Flush the isolate's pending count to KV, at most once per minute.
 *
 * Deliberately fire-and-forget from the request's point of view — call it
 * through `ctx.waitUntil` so a slow KV write never adds latency to a turn that
 * a visitor is waiting on.
 */
export async function flushDailyCount(env: Env, nowMs: number): Promise<void> {
  if (state.pendingTurns === 0) return;
  if (nowMs - state.lastFlushAt < CACHE_TTL_MS) return;

  const today = dayKey(nowMs);
  const toAdd = state.pendingTurns;
  state.pendingTurns = 0;
  state.lastFlushAt = nowMs;

  try {
    const raw = await env.STATE.get(`${DAILY_PREFIX}${today}`);
    const current = raw === null ? 0 : Number.parseInt(raw, 10);
    const next = (Number.isFinite(current) ? current : 0) + toAdd;
    // Expire the day after tomorrow so old counters clean themselves up.
    await env.STATE.put(`${DAILY_PREFIX}${today}`, String(next), { expirationTtl: 60 * 60 * 48 });
    state.knownTotal = next;
    state.totalCheckedAt = nowMs;
  } catch {
    // Put the count back so it is not silently lost, and try again next minute.
    state.pendingTurns += toAdd;
  }
}

/** Record one model turn against the day's ceiling. */
export function countTurn(): void {
  state.pendingTurns += 1;
}

export async function dailyCeilingReached(env: Env, nowMs: number): Promise<boolean> {
  const ceiling = Number.parseInt(env.DAILY_TURN_CEILING, 10);
  if (!Number.isFinite(ceiling) || ceiling <= 0) return false;
  return (await readDailyTotal(env, nowMs)) >= ceiling;
}

/* ------------------------------------------------------------------ mode -- */

/**
 * What the client should be told before it starts.
 *
 * `degraded` is not an error. It means "use the rule brain today", and the
 * visitor sees a small `simple mode` tag rather than anything alarming (R-38).
 */
export async function currentMode(env: Env, nowSeconds: number): Promise<GatewayMode> {
  const nowMs = nowSeconds * 1000;
  if (await killSwitchOn(env, nowMs)) return 'degraded';
  if (await dailyCeilingReached(env, nowMs)) return 'degraded';
  return 'full';
}

/* ------------------------------------------------------- session budgets -- */

/**
 * Per-session spend, held in KV under the session id.
 *
 * One write per session rather than one per request: the counter is read at the
 * start of a request and written only when it crosses a checkpoint. A session
 * lives 20 minutes and the record expires with it.
 */
export interface SessionSpend {
  turns: number;
  ttsSeconds: number;
  clips: number;
}

const EMPTY_SPEND: SessionSpend = { turns: 0, ttsSeconds: 0, clips: 0 };

export async function readSpend(env: Env, sid: string): Promise<SessionSpend> {
  try {
    const raw = await env.STATE.get(`spend:${sid}`);
    if (raw === null) return { ...EMPTY_SPEND };
    const parsed: unknown = JSON.parse(raw);
    const record = parsed as Partial<SessionSpend>;
    return {
      turns: typeof record.turns === 'number' ? record.turns : 0,
      ttsSeconds: typeof record.ttsSeconds === 'number' ? record.ttsSeconds : 0,
      clips: typeof record.clips === 'number' ? record.clips : 0,
    };
  } catch {
    return { ...EMPTY_SPEND };
  }
}

export async function writeSpend(env: Env, sid: string, spend: SessionSpend): Promise<void> {
  try {
    await env.STATE.put(`spend:${sid}`, JSON.stringify(spend), { expirationTtl: 60 * 30 });
  } catch {
    // A lost write means a session might get one extra turn. Acceptable; the
    // rate-limit binding still caps the rate, and the day ceiling still caps
    // the total.
  }
}

export type SpendKind = 'turns' | 'ttsSeconds' | 'clips';

export interface SpendResult {
  readonly allowed: boolean;
  readonly spend: SessionSpend;
}

/** Check and record spend against a session's own quota. */
export async function spend(
  env: Env,
  sid: string,
  quota: SessionQuota,
  kind: SpendKind,
  amount = 1,
): Promise<SpendResult> {
  const current = await readSpend(env, sid);
  const limit = quota[kind];
  if (current[kind] + amount > limit) return { allowed: false, spend: current };

  current[kind] += amount;
  await writeSpend(env, sid, current);
  return { allowed: true, spend: current };
}

/** Per-session request rate, using the binding rather than KV. */
export async function withinSessionRate(env: Env, sid: string): Promise<boolean> {
  if (env.SESSION_LIMITER === undefined) return true;
  const result = await env.SESSION_LIMITER.limit({ key: sid });
  return result.success;
}
