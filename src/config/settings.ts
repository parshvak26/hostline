/**
 * Every timeout, threshold and budget in one place.
 *
 * These numbers come from the latency budget in plan §12.5 and the failure
 * matrix in §7.5. They are collected here rather than scattered through the
 * orchestrator because tuning them is a normal part of making a voice interface
 * feel right, and hunting for a magic number across six files is how a demo
 * stops being tunable.
 */

/** Speech recognition and end-of-speech detection. */
export const LISTENING = {
  /**
   * Silence after the last interim result before the turn is considered over.
   *
   * The browser's own `final` event is slower and inconsistent, so this is what
   * actually defines t0. 600ms is the plan's figure: short enough to feel
   * responsive, long enough to survive a mid-sentence breath.
   */
  endpointSilenceMs: 600,
  /** "Are you still there?" after this much silence while listening. */
  idlePromptMs: 8_000,
  /** Stop listening this long after the idle prompt goes unanswered. */
  idleGiveUpMs: 8_000,
  /**
   * Recognition is muted while the agent speaks, plus this tail, so the last
   * syllable of the agent's own voice does not arrive as a visitor turn.
   */
  playbackMuteTailMs: 250,
  /** Consecutive unparseable turns before typing is offered (plan §4.3). */
  failuresBeforeOfferTyping: 2,
  /** Consecutive unparseable turns before switching to typing automatically. */
  failuresBeforeForceTyping: 3,
} as const;

/** Barge-in, per R-22. */
export const BARGE_IN = {
  /** RMS above this, sustained, counts as the visitor speaking over the agent. */
  rmsThreshold: 0.045,
  /** Sustained for this long before firing, which is what rejects a door slam. */
  sustainedMs: 120,
  /** Audio must be silent within this budget. Asserted by an e2e test. */
  stopBudgetMs: 150,
} as const;

/** The turn loop's timers, per plan §7.5 F3/F4. */
export const TURN = {
  /** Past this with no first token, play a filler rather than leave dead air. */
  fillerAfterMs: 400,
  /** Past this, the rule brain finishes the turn. */
  brainTimeoutMs: 2_500,
  /** Consecutive brain failures before the session gives up on the LLM. */
  failuresBeforeRuleMode: 3,
  /** How long a session stays in rule mode before re-probing the gateway. */
  reprobeGatewayMs: 60_000,
  /** Maximum agent turns in one conversation, matching the gateway's cap. */
  maxTurns: 12,
} as const;

/** Gateway client behaviour. Server-side limits are the real enforcement. */
export const GATEWAY = {
  sessionTtlMs: 20 * 60 * 1000,
  /** Refresh a session this long before it expires. */
  sessionRefreshMarginMs: 60_000,
  healthPollMs: 60_000,
  /** Any request that has not started streaming by now is treated as failed. */
  requestTimeoutMs: 3_000,
  /** Hard cap on a single `/speak` request's text, matching the worker's. */
  maxSpeakChars: 240,
  /** Hard cap on one `/listen` clip. */
  maxListenBytes: 400 * 1024,
  maxListenMs: 10_000,
} as const;

/** Speech synthesis cascade, per T-082. */
export const SPEECH = {
  /** A prebaked clip must reach audible output inside this. */
  cacheHitBudgetMs: 150,
  /**
   * Sentence boundary detection cuts the model stream here so speech can start
   * before generation finishes (R-21). Below this, chunks are too short to
   * synthesise well; above it, the visitor is waiting for no reason.
   */
  minSentenceChars: 12,
  maxSentenceChars: 240,
  /**
   * The longest a turn will wait to be heard before carrying on regardless.
   *
   * Generous — a two-sentence reply read aloud is a few seconds — but finite.
   * Some platforms have no voices installed and never fire `onend`, and the
   * conversation must not be held hostage to whether the words came out.
   */
  turnSpeechCeilingMs: 12_000,
} as const;

/** Storage. */
export const STORAGE = {
  dbName: 'hostline',
  dbVersion: 1,
  bookingStore: 'bookings',
  transcriptStore: 'transcripts',
} as const;

/**
 * Public build-time values. Both are public by design (plan §18) — the gateway
 * URL is a URL, and a Turnstile *site* key is meant to be in the page. No
 * secret has ever been in this file and a CI secret scan proves it.
 */
export const PUBLIC_CONFIG = {
  gatewayUrl: (import.meta.env?.['VITE_GATEWAY_URL'] as string | undefined) ?? '',
  turnstileSiteKey: (import.meta.env?.['VITE_TURNSTILE_SITE_KEY'] as string | undefined) ?? '',
  repositoryUrl: 'https://github.com/parshvak26/hostline',
} as const;

/** True when the site has been pointed at a deployed gateway. */
export function hasGateway(): boolean {
  return PUBLIC_CONFIG.gatewayUrl.trim() !== '';
}
