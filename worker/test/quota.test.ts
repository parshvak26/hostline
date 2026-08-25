/**
 * Quotas and the kill switch (T-062).
 *
 * The thing worth testing here is not that a counter counts. It is that the
 * **coalescing** works — that the daily ceiling holds while spending far fewer
 * than one KV write per request, because Cloudflare's free tier allows roughly
 * a thousand writes a day and a naive counter would exhaust that before lunch
 * (plan §11).
 *
 * The tests therefore count KV writes as well as outcomes.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';

import {
  countTurn,
  currentMode,
  dailyCeilingReached,
  dayKey,
  flushDailyCount,
  killSwitchOn,
  readSpend,
  resetIsolateState,
  spend,
  withinSessionRate,
  writeSpend,
} from '../src/quota.js';
import type { Env } from '../src/types.js';
import { DEFAULT_QUOTA } from '../src/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOON = Date.UTC(2026, 7, 25, 12, 0, 0);

async function wipe(): Promise<void> {
  const listed = await env.STATE.list();
  await Promise.all(listed.keys.map((k) => env.STATE.delete(k.name)));
}

beforeEach(async () => {
  resetIsolateState();
  await wipe();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------- kill switch -- */

describe('the kill switch (R-37)', () => {
  it('is off by default', async () => {
    expect(await killSwitchOn(env, NOON)).toBe(false);
  });

  it('turns on from a KV key, with no redeploy', async () => {
    await env.STATE.put('kill_switch', 'on');
    resetIsolateState();
    expect(await killSwitchOn(env, NOON)).toBe(true);
  });

  it('is case- and whitespace-tolerant, because a human types it', async () => {
    await env.STATE.put('kill_switch', '  ON  ');
    resetIsolateState();
    expect(await killSwitchOn(env, NOON)).toBe(true);
  });

  it('takes effect within sixty seconds of being flipped', async () => {
    // The isolate caches its view for a minute (plan §11), which is what keeps
    // the read budget small. R-37 asks for "within 60s", so the cache TTL *is*
    // the guarantee, and this pins it.
    expect(await killSwitchOn(env, NOON)).toBe(false);

    await env.STATE.put('kill_switch', 'on');

    // Inside the cache window: still the old answer.
    expect(await killSwitchOn(env, NOON + 30_000)).toBe(false);
    // Past it: the new one.
    expect(await killSwitchOn(env, NOON + 61_000)).toBe(true);
  });

  it('stays off rather than failing when KV is unreadable', async () => {
    // A KV outage must not take the gateway down. The providers' own limits
    // remain the real backstop (plan §11).
    vi.spyOn(env.STATE, 'get').mockRejectedValue(new Error('kv down'));
    resetIsolateState();
    expect(await killSwitchOn(env, NOON)).toBe(false);
  });
});

/* --------------------------------------------------------- daily ceiling -- */

describe('the daily ceiling', () => {
  it('is not reached on a quiet day', async () => {
    expect(await dailyCeilingReached(env, NOON)).toBe(false);
  });

  it('is reached once the stored count crosses the configured ceiling', async () => {
    const ceiling = Number.parseInt(env.DAILY_TURN_CEILING, 10);
    await env.STATE.put(`daily:${dayKey(NOON)}`, String(ceiling));
    resetIsolateState();
    expect(await dailyCeilingReached(env, NOON)).toBe(true);
  });

  it('counts turns held in the isolate before they are ever written', async () => {
    // The count that matters is stored + pending. Without this an isolate could
    // serve a whole minute's traffic past the ceiling before its first flush.
    const ceiling = Number.parseInt(env.DAILY_TURN_CEILING, 10);
    await env.STATE.put(`daily:${dayKey(NOON)}`, String(ceiling - 2));
    resetIsolateState();

    expect(await dailyCeilingReached(env, NOON)).toBe(false);
    countTurn();
    countTurn();
    expect(await dailyCeilingReached(env, NOON)).toBe(true);
  });

  it('coalesces writes: a hundred turns cost at most one KV write per minute', async () => {
    // The constraint the whole design exists for. A naive counter would spend
    // 100 of the ~1,000 daily writes here.
    const put = vi.spyOn(env.STATE, 'put');
    resetIsolateState();

    for (let i = 0; i < 100; i += 1) {
      countTurn();
      await flushDailyCount(env, NOON + i * 100);
    }

    expect(put.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('writes again after the coalescing window', async () => {
    const put = vi.spyOn(env.STATE, 'put');
    resetIsolateState();

    countTurn();
    await flushDailyCount(env, NOON);
    countTurn();
    await flushDailyCount(env, NOON + 61_000);

    expect(put.mock.calls.length).toBe(2);
  });

  it('adds to the stored total rather than replacing it', async () => {
    // Several isolates share the key. An isolate that wrote its own count as
    // the total would silently erase every other isolate's traffic.
    await env.STATE.put(`daily:${dayKey(NOON)}`, '40');
    resetIsolateState();

    countTurn();
    countTurn();
    await flushDailyCount(env, NOON + 61_000);

    expect(await env.STATE.get(`daily:${dayKey(NOON)}`)).toBe('42');
  });

  it('keeps the pending count when a write fails, instead of losing it', async () => {
    vi.spyOn(env.STATE, 'put').mockRejectedValueOnce(new Error('kv write failed'));
    resetIsolateState();

    countTurn();
    countTurn();
    await flushDailyCount(env, NOON);

    // The failed write is retried on the next window rather than dropped.
    await flushDailyCount(env, NOON + 121_000);
    expect(await env.STATE.get(`daily:${dayKey(NOON)}`)).toBe('2');
  });

  it('starts a fresh budget when the day rolls over', async () => {
    const ceiling = Number.parseInt(env.DAILY_TURN_CEILING, 10);
    await env.STATE.put(`daily:${dayKey(NOON)}`, String(ceiling));
    resetIsolateState();
    expect(await dailyCeilingReached(env, NOON)).toBe(true);

    expect(await dailyCeilingReached(env, NOON + DAY_MS)).toBe(false);
  });

  it('ignores a nonsense ceiling rather than blocking everything', async () => {
    const broken = { ...env, DAILY_TURN_CEILING: 'not-a-number' };
    resetIsolateState();
    expect(await dailyCeilingReached(broken, NOON)).toBe(false);
  });
});

/* ------------------------------------------------------------------ mode -- */

describe('currentMode', () => {
  it('is full when nothing is wrong', async () => {
    expect(await currentMode(env, NOON / 1000)).toBe('full');
  });

  it('is degraded when the kill switch is on', async () => {
    await env.STATE.put('kill_switch', 'on');
    resetIsolateState();
    expect(await currentMode(env, NOON / 1000)).toBe('degraded');
  });

  it('is degraded when the day is spent', async () => {
    await env.STATE.put(`daily:${dayKey(NOON)}`, env.DAILY_TURN_CEILING);
    resetIsolateState();
    expect(await currentMode(env, NOON / 1000)).toBe('degraded');
  });
});

/* --------------------------------------------------------- session spend -- */

describe('per-session spend', () => {
  it('starts empty', async () => {
    expect(await readSpend(env, 'sid-new')).toEqual({ turns: 0, ttsSeconds: 0, clips: 0 });
  });

  it('allows spending up to the quota and refuses beyond it', async () => {
    const sid = 'sid-turns';
    for (let i = 0; i < DEFAULT_QUOTA.turns; i += 1) {
      const result = await spend(env, sid, DEFAULT_QUOTA, 'turns');
      expect(result.allowed).toBe(true);
    }

    const over = await spend(env, sid, DEFAULT_QUOTA, 'turns');
    expect(over.allowed).toBe(false);
    expect(over.spend.turns).toBe(DEFAULT_QUOTA.turns);
  });

  it('refuses a single request larger than the whole remaining quota', async () => {
    const sid = 'sid-tts';
    const result = await spend(env, sid, DEFAULT_QUOTA, 'ttsSeconds', DEFAULT_QUOTA.ttsSeconds + 1);
    expect(result.allowed).toBe(false);
    expect((await readSpend(env, sid)).ttsSeconds).toBe(0);
  });

  it('keeps the three budgets independent', async () => {
    const sid = 'sid-mixed';
    await spend(env, sid, DEFAULT_QUOTA, 'turns');
    await spend(env, sid, DEFAULT_QUOTA, 'clips');

    const current = await readSpend(env, sid);
    expect(current.turns).toBe(1);
    expect(current.clips).toBe(1);
    expect(current.ttsSeconds).toBe(0);
  });

  it('treats a corrupt record as empty rather than throwing', async () => {
    await env.STATE.put('spend:sid-corrupt', 'not json');
    expect(await readSpend(env, 'sid-corrupt')).toEqual({ turns: 0, ttsSeconds: 0, clips: 0 });
  });

  it('ignores negative or non-numeric fields in a stored record', async () => {
    await env.STATE.put('spend:sid-odd', JSON.stringify({ turns: 'many', ttsSeconds: null }));
    expect(await readSpend(env, 'sid-odd')).toEqual({ turns: 0, ttsSeconds: 0, clips: 0 });
  });

  it('survives a failed write without throwing', async () => {
    vi.spyOn(env.STATE, 'put').mockRejectedValue(new Error('kv down'));
    await expect(writeSpend(env, 'sid-x', { turns: 1, ttsSeconds: 0, clips: 0 })).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------ rate limit -- */

describe('per-session rate limiting', () => {
  it('allows requests when no limiter binding is configured', async () => {
    // A fork without the unsafe binding still works; it just leans harder on
    // the session quota and the daily ceiling.
    //
    // Built by deleting the key rather than setting it to `undefined`, because
    // `exactOptionalPropertyTypes` treats those as different things — and an
    // absent binding is genuinely an absent key, which is what the runtime
    // hands the worker.
    const withoutLimiter: Env = { ...env };
    delete (withoutLimiter as { SESSION_LIMITER?: unknown }).SESSION_LIMITER;
    expect(await withinSessionRate(withoutLimiter, 'sid')).toBe(true);
  });

  it('refuses when the limiter says no', async () => {
    const limited = { ...env, SESSION_LIMITER: { limit: async () => ({ success: false }) } };
    expect(await withinSessionRate(limited, 'sid')).toBe(false);
  });

  it('uses the session id as the key, so one visitor cannot spend another’s budget', async () => {
    const keys: string[] = [];
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: true };
      },
    };

    await withinSessionRate({ ...env, SESSION_LIMITER: limiter }, 'sid-a');
    await withinSessionRate({ ...env, SESSION_LIMITER: limiter }, 'sid-b');

    expect(keys).toEqual(['sid-a', 'sid-b']);
  });
});
