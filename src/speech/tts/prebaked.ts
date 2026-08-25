/**
 * The prebaked audio cache (T-082) — the reason the latency target is reachable.
 *
 * Synthesising a line costs 200–400ms. The agent says "which day were you
 * thinking?" in every single conversation, and paying for it every time is most
 * of a one-second budget spent on a sentence that never changes. So the fixed
 * lines are synthesised once at build time (`scripts/bake-audio.ts`), committed
 * as Opus, and served from the same origin as the page: **0ms of synthesis, and
 * usually a cache hit in the browser too**.
 *
 * Two things keep this honest:
 *
 *   - The manifest is fetched **after first contentful paint**, never on the
 *     critical path. A cache that delayed the page it exists to speed up would
 *     be a poor trade.
 *   - A miss is silent and cheap. Nothing here is required; if the manifest is
 *     absent — which it is until the operator runs the bake script — every line
 *     falls through to hosted or browser speech and the site is fully working.
 */

import type { SpeechClip, SpeechOutput, SpeechRequest } from '../../agent/ports.js';

interface ManifestClip {
  readonly file: string;
  readonly hash: string;
  readonly bytes: number;
  readonly text: string;
}

interface Manifest {
  readonly clips: Record<string, ManifestClip>;
}

export interface PrebakedOptions {
  /** Base URL for `public/audio/`. Respects Vite's configured base path. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * A cache-only speech source.
 *
 * `resolve` rejects on a miss rather than falling back, because the cascade in
 * `index.ts` owns the decision about what to do next. A source that quietly
 * substituted a different source would make the latency numbers meaningless.
 */
export class PrebakedSpeech implements SpeechOutput {
  readonly kind = 'prebaked' as const;

  private manifest: Manifest | null = null;
  private loading: Promise<void> | null = null;
  private readonly audio = new Map<string, ArrayBuffer>();
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(options: PrebakedOptions = {}) {
    const base = options.baseUrl ?? `${import.meta.env?.BASE_URL ?? '/'}audio/`;
    this.baseUrl = base.endsWith('/') ? base : `${base}/`;
    this.doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** True once the manifest is known and at least one clip exists. */
  get available(): boolean {
    return this.manifest !== null && Object.keys(this.manifest.clips).length > 0;
  }

  /**
   * Load the manifest. Safe to call repeatedly and safe to fail.
   *
   * Called during idle after FCP as part of the warm-up sequence (T-084).
   */
  async warm(): Promise<void> {
    if (this.manifest !== null) return;
    if (this.loading !== null) return this.loading;

    this.loading = (async () => {
      try {
        const response = await this.doFetch(`${this.baseUrl}manifest.json`);
        if (!response.ok) return;
        const parsed: unknown = await response.json();
        const record = parsed as { clips?: unknown };
        if (typeof record.clips === 'object' && record.clips !== null) {
          this.manifest = { clips: record.clips as Record<string, ManifestClip> };
        }
      } catch {
        // No manifest is a completely normal state — it means the operator has
        // not run the bake script yet. Everything still works, a little slower.
      } finally {
        this.loading = null;
      }
    })();

    return this.loading;
  }

  /** Fetch the clips for the lines most likely to be needed first. */
  async prefetch(ids: readonly string[]): Promise<void> {
    await this.warm();
    await Promise.all(ids.map((id) => this.load(id).catch(() => undefined)));
  }

  private async load(id: string): Promise<ArrayBuffer | null> {
    const cached = this.audio.get(id);
    if (cached !== undefined) return cached;

    const clip = this.manifest?.clips[id];
    if (clip === undefined) return null;

    const response = await this.doFetch(`${this.baseUrl}${clip.file}`);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    this.audio.set(id, buffer);
    return buffer;
  }

  /** The manifest key for a request, or null when the line is not fixed copy. */
  static idFor(request: SpeechRequest): string | null {
    if (request.phraseKey === undefined) return null;
    return `${request.phraseKey}.${request.variant ?? 0}`;
  }

  async resolve(request: SpeechRequest, signal?: AbortSignal): Promise<SpeechClip> {
    const started = performance.now();
    const id = PrebakedSpeech.idFor(request);
    if (id === null) throw new Error('not a prebaked line');

    await this.warm();
    if (signal?.aborted === true) throw new Error('aborted');

    const audio = await this.load(id);
    if (audio === null) throw new Error(`no baked clip for ${id}`);

    return { source: 'prebaked', audio, resolvedInMs: performance.now() - started };
  }

  cancel(): void {
    // Nothing to cancel: a cache hit is a map lookup and a fetch of a file the
    // browser has usually already cached.
  }
}
