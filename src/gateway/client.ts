/**
 * The browser's half of the gateway conversation (T-066).
 *
 * Everything this file does is arranged around one idea: **a failure here is
 * never an error the visitor sees.** Every non-200, every timeout, every
 * unreachable host maps to a row in plan §7.5 and the answer is always some
 * flavour of "use the rule brain and the browser's own voice". The client's job
 * is to find that out quickly and get out of the way.
 *
 * Three things are worth reading closely:
 *
 *   - **`parseSse`** is a standalone, testable function, because reassembling
 *     server-sent events across chunk boundaries is the named failure point for
 *     this phase (plan §19). Network chunks do not align to event boundaries and
 *     a parser that assumes they do works perfectly until it does not.
 *   - **Every request carries an `AbortSignal`.** Barge-in has to cancel the
 *     in-flight model and speech requests, not just stop the audio, or the agent
 *     resumes a sentence nobody is listening to any more (T-085, R-22).
 *   - **`describeFailure`** turns a status code into a degradation, in one
 *     place, so the orchestrator never has to reason about HTTP.
 */

import { GATEWAY, PUBLIC_CONFIG, hasGateway } from '../config/settings.js';
import type { GatewayMode, GatewayStatus } from '../agent/ports.js';

/* ----------------------------------------------------------------- types -- */

export interface SessionQuota {
  readonly turns: number;
  readonly ttsSeconds: number;
  readonly clips: number;
}

export interface Session {
  readonly token: string;
  readonly expiresAt: number;
  readonly mode: GatewayMode;
  readonly quota: SessionQuota;
}

/** What the orchestrator should do about a failure. Never "show an error". */
export type Degradation =
  /** This turn only: finish it with the rule brain, try the model again next turn. */
  | 'rule_brain_this_turn'
  /** This visit: the gateway is out for now; re-probe after a minute. */
  | 'rule_brain_this_session'
  /** Speech only: use `speechSynthesis` instead. */
  | 'browser_voice'
  /** Recognition only: offer typing. */
  | 'typed_mode';

export interface GatewayFailure {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly degradation: Degradation;
}

export class GatewayError extends Error {
  override readonly name = 'GatewayError';
  constructor(readonly failure: GatewayFailure) {
    super(`gateway ${failure.status} ${failure.code}`);
  }
}

/* ------------------------------------------------------------------- SSE -- */

export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/**
 * Incremental SSE parser.
 *
 * Feed it whatever arrived; it returns the complete events and keeps the
 * remainder for next time. Deliberately a closure over a string buffer rather
 * than anything cleverer — the failure mode this guards against is subtle and
 * the code that guards against it should not be.
 */
export function createSseParser(): (chunk: string) => SseEvent[] {
  let buffer = '';

  return (chunk: string): SseEvent[] => {
    buffer += chunk;
    const events: SseEvent[] = [];

    // Events are separated by a blank line. Both \n\n and \r\n\r\n occur in the
    // wild; normalising first is cheaper than matching both everywhere.
    buffer = buffer.replace(/\r\n/g, '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event = 'message';
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line === '' || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        // "data: x" and "data:x" are both legal; one leading space is stripped.
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') dataLines.push(value);
      }

      if (dataLines.length > 0) events.push({ event, data: dataLines.join('\n') });
      boundary = buffer.indexOf('\n\n');
    }

    return events;
  };
}

/** Read a `Response` body as SSE events. Stops cleanly when aborted. */
export async function* readSse(response: Response, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const body = response.body;
  if (body === null) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();

  try {
    for (;;) {
      if (signal?.aborted === true) return;
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parse(decoder.decode(value, { stream: true }))) yield event;
    }
    // Flush whatever the decoder is still holding, then any trailing event.
    for (const event of parse(decoder.decode())) yield event;
  } finally {
    // Releasing the reader is what actually stops the upstream transfer when a
    // barge-in aborts mid-stream.
    reader.releaseLock();
    if (signal?.aborted === true) await body.cancel().catch(() => undefined);
  }
}

/* -------------------------------------------------------------- failures -- */

/**
 * Status code → what to do about it (plan §7.5).
 *
 * The mapping lives here rather than at each call site so that adding a new
 * provider error means editing one table, and so the e2e tests can assert the
 * mapping directly.
 */
export function describeFailure(status: number, code: string, retryable: boolean, endpoint: string): GatewayFailure {
  const speechOrListen: Degradation = endpoint === '/speak' ? 'browser_voice' : 'typed_mode';

  let degradation: Degradation;
  if (status === 0) {
    // Network-level failure: the gateway is not reachable at all (F1).
    degradation = 'rule_brain_this_session';
  } else if (code === 'degraded_kill_switch' || code === 'daily_ceiling') {
    // The owner's switch, or the day's ceiling. Neither will change in the next
    // few seconds, so there is no point retrying this visit (F2).
    degradation = 'rule_brain_this_session';
  } else if (status === 401 || status === 403) {
    degradation = endpoint === '/chat' ? 'rule_brain_this_session' : speechOrListen;
  } else if (endpoint === '/chat') {
    degradation = 'rule_brain_this_turn';
  } else {
    degradation = speechOrListen;
  }

  return { code, status, retryable, degradation };
}

async function failureFrom(response: Response, endpoint: string): Promise<GatewayFailure> {
  let code = `http_${response.status}`;
  let retryable = response.status >= 500 || response.status === 429;
  try {
    const parsed: unknown = await response.json();
    const record = parsed as { code?: unknown; retryable?: unknown };
    if (typeof record.code === 'string') code = record.code;
    if (typeof record.retryable === 'boolean') retryable = record.retryable;
  } catch {
    // A non-JSON error body is itself informative enough: something between us
    // and the worker answered, and it was not the worker.
  }
  return describeFailure(response.status, code, retryable, endpoint);
}

/* ---------------------------------------------------------------- client -- */

export interface GatewayClientOptions {
  readonly baseUrl?: string;
  /** Injected so tests can drive it without a real network. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface ChatRequest {
  readonly messages: ReadonlyArray<{ role: string; content: string }>;
  readonly engineState: unknown;
  readonly locale: string;
}

export interface ChatToken {
  readonly type: 'token';
  readonly text: string;
}
export interface ChatToolCall {
  readonly type: 'tool_call';
  readonly name: string;
  readonly arguments: unknown;
}
export interface ChatDone {
  readonly type: 'done';
}
export type ChatEvent = ChatToken | ChatToolCall | ChatDone;

export class GatewayClient {
  private session: Session | null = null;
  private sessionPromise: Promise<Session> | null = null;
  private lastHealth: GatewayStatus = { mode: 'unreachable' };
  private lastHealthAt = 0;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  constructor(options: GatewayClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? PUBLIC_CONFIG.gatewayUrl).replace(/\/$/, '');
    this.doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => Date.now());
  }

  /** False when the site was built without a gateway URL, which is a valid state. */
  get configured(): boolean {
    return this.baseUrl !== '' && hasGateway();
  }

  get mode(): GatewayMode {
    return this.lastHealth.mode;
  }

  /**
   * Ask whether the hosted path is worth attempting.
   *
   * Cached for a minute, because the answer changes at most once a day and the
   * client should not spend a request per turn finding that out.
   */
  async health(signal?: AbortSignal): Promise<GatewayStatus> {
    if (!this.configured) return { mode: 'unreachable', reason: 'no_gateway_configured' };
    if (this.now() - this.lastHealthAt < GATEWAY.healthPollMs) return this.lastHealth;

    try {
      const response = await this.doFetch(`${this.baseUrl}/health`, {
        method: 'GET',
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        this.lastHealth = { mode: 'unreachable', reason: `http_${response.status}` };
      } else {
        const parsed: unknown = await response.json();
        const record = parsed as { mode?: unknown; reason?: unknown };
        const mode: GatewayMode = record.mode === 'full' ? 'full' : 'degraded';
        this.lastHealth =
          typeof record.reason === 'string' ? { mode, reason: record.reason } : { mode };
      }
    } catch {
      this.lastHealth = { mode: 'unreachable', reason: 'unreachable' };
    }

    this.lastHealthAt = this.now();
    return this.lastHealth;
  }

  /**
   * Get a session, reusing the current one until it is close to expiring.
   *
   * Concurrent callers share one in-flight request — three requests racing on
   * the first turn would otherwise burn three of the five sessions an IP is
   * allowed per hour.
   */
  async ensureSession(turnstileToken: string): Promise<Session> {
    const current = this.session;
    if (current !== null && current.expiresAt - this.now() > GATEWAY.sessionRefreshMarginMs) return current;
    if (this.sessionPromise !== null) return this.sessionPromise;

    this.sessionPromise = this.requestSession(turnstileToken).finally(() => {
      this.sessionPromise = null;
    });
    return this.sessionPromise;
  }

  private async requestSession(turnstileToken: string): Promise<Session> {
    const response = await this.doFetch(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstileToken }),
      signal: AbortSignal.timeout(GATEWAY.requestTimeoutMs),
    }).catch(() => null);

    if (response === null) {
      throw new GatewayError(describeFailure(0, 'unreachable', true, '/session'));
    }
    if (!response.ok) throw new GatewayError(await failureFrom(response, '/session'));

    const parsed: unknown = await response.json();
    const record = parsed as Partial<Session>;
    if (typeof record.token !== 'string' || typeof record.expiresAt !== 'number') {
      throw new GatewayError(describeFailure(502, 'bad_session_response', false, '/session'));
    }

    const session: Session = {
      token: record.token,
      expiresAt: record.expiresAt,
      mode: record.mode === 'full' ? 'full' : 'degraded',
      quota: record.quota ?? { turns: 0, ttsSeconds: 0, clips: 0 },
    };
    this.session = session;
    return session;
  }

  private authHeaders(): Record<string, string> {
    const token = this.session?.token;
    return token === undefined ? {} : { Authorization: `Bearer ${token}` };
  }

  /**
   * Stream a model turn.
   *
   * Yields tokens as they arrive so the orchestrator can cut at the first
   * sentence boundary and start speaking (R-21) — which is why this is a
   * generator rather than a promise of a finished reply.
   */
  async *chat(request: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const response = await this.doFetch(`${this.baseUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...this.authHeaders() },
      body: JSON.stringify(request),
      signal,
    }).catch(() => null);

    if (response === null) throw new GatewayError(describeFailure(0, 'unreachable', true, '/chat'));
    if (!response.ok) throw new GatewayError(await failureFrom(response, '/chat'));

    for await (const event of readSse(response, signal)) {
      if (event.event === 'done' || event.data === '[DONE]') {
        yield { type: 'done' };
        return;
      }
      if (event.event === 'error') {
        throw new GatewayError(describeFailure(503, 'stream_error', true, '/chat'));
      }
      if (event.event === 'tool_call') {
        // The arguments are forwarded exactly as they arrived, including when
        // they will not parse. The engine is built to reject malformed tool
        // arguments with a typed reason (adversarial case 12); repairing them
        // here would hide a real model failure and weaken that test.
        try {
          const parsed: unknown = JSON.parse(event.data);
          const record = parsed as { name?: unknown; arguments?: unknown };
          yield {
            type: 'tool_call',
            name: typeof record.name === 'string' ? record.name : '',
            arguments: record.arguments,
          };
        } catch {
          yield { type: 'tool_call', name: '', arguments: event.data };
        }
        continue;
      }
      if (event.event === 'token' || event.event === 'message') {
        try {
          const parsed: unknown = JSON.parse(event.data);
          const record = parsed as { text?: unknown };
          if (typeof record.text === 'string') yield { type: 'token', text: record.text };
        } catch {
          yield { type: 'token', text: event.data };
        }
      }
    }

    yield { type: 'done' };
  }

  /** Synthesise a line. Returns the audio, or throws a mapped failure. */
  async speak(text: string, voice: string, signal: AbortSignal): Promise<ArrayBuffer> {
    if (text.length > GATEWAY.maxSpeakChars) {
      throw new GatewayError(describeFailure(413, 'text_too_long', false, '/speak'));
    }

    const response = await this.doFetch(`${this.baseUrl}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ text, voice, format: 'opus' }),
      signal,
    }).catch(() => null);

    if (response === null) throw new GatewayError(describeFailure(0, 'unreachable', true, '/speak'));
    if (!response.ok) throw new GatewayError(await failureFrom(response, '/speak'));
    return response.arrayBuffer();
  }

  /** Transcribe a clip where the browser cannot. */
  async listen(audio: Blob, locale: string, signal: AbortSignal): Promise<{ text: string; confidence?: number }> {
    if (audio.size > GATEWAY.maxListenBytes) {
      throw new GatewayError(describeFailure(413, 'audio_too_large', false, '/listen'));
    }

    const form = new FormData();
    form.append('audio', audio, 'clip.webm');
    form.append('locale', locale);

    const response = await this.doFetch(`${this.baseUrl}/listen`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
      signal,
    }).catch(() => null);

    if (response === null) throw new GatewayError(describeFailure(0, 'unreachable', true, '/listen'));
    if (!response.ok) throw new GatewayError(await failureFrom(response, '/listen'));

    const parsed: unknown = await response.json();
    const record = parsed as { text?: unknown; confidence?: unknown };
    return {
      text: typeof record.text === 'string' ? record.text : '',
      ...(typeof record.confidence === 'number' ? { confidence: record.confidence } : {}),
    };
  }

  /**
   * Warm the connection during the hero read (R-24, T-084).
   *
   * A preconnect plus a health check costs one round trip that the visitor is
   * not waiting on, and saves TLS setup from the first turn that they are.
   */
  async warm(): Promise<void> {
    if (!this.configured) return;
    await this.health().catch(() => undefined);
  }
}
