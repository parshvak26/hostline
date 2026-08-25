/**
 * `GET /health` — the one thing the client asks before committing to anything.
 *
 * The client polls this at most once a minute (plan §11) so it can decide, up
 * front and without a session, whether the hosted path is worth attempting
 * today. Answering `degraded` here is how a day at the free-tier ceiling turns
 * into "the agent is a little more to the point" rather than a stall on the
 * first turn.
 *
 * No authentication, and deliberately so: a client with no session still needs
 * the answer. It leaks nothing beyond whether the demo is in simple mode, which
 * is written on the page anyway.
 */

import type { Env } from './types.js';
import { currentMode, killSwitchOn, dailyCeilingReached } from './quota.js';

export async function handleHealth(env: Env, nowSeconds: number): Promise<Response> {
  const mode = await currentMode(env, nowSeconds);

  // The reason is included because it is genuinely useful to the owner when
  // something looks wrong, and because "degraded" with no explanation is the
  // sort of thing that gets debugged by guessing.
  let reason: string | undefined;
  if (mode === 'degraded') {
    reason = (await killSwitchOn(env, nowSeconds * 1000))
      ? 'kill_switch'
      : (await dailyCeilingReached(env, nowSeconds * 1000))
        ? 'daily_ceiling'
        : 'unknown';
  }

  return new Response(JSON.stringify(reason === undefined ? { mode } : { mode, reason }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Matches the client's poll interval, so a healthy gateway costs one
      // request per visitor per minute at most.
      'Cache-Control': 'max-age=60',
    },
  });
}
