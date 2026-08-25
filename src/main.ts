/**
 * The composition root.
 *
 * Everything impure is assembled here and nowhere else: the clock, the
 * identifiers, the microphone, the speaker, the storage, the network. Each is
 * chosen at startup, wired into the orchestrator, and never reached for again.
 *
 * That is what makes the rest of the codebase testable — and it is also the
 * degradation chain made literal. Read the `select…` functions below and you can
 * see, in one place, every rung the system can fall to:
 *
 *   - a gateway, or no gateway at all
 *   - the model, or the rule brain
 *   - a baked clip, a neural voice, or `speechSynthesis`
 *   - browser recognition, hosted recognition, or typing
 *   - IndexedDB, or memory
 *
 * **Every one of those has a working right-hand side.** A build with no gateway
 * URL, opened in a browser with no speech recognition and no microphone, in
 * private mode, still books a table by typing. That is R-34, and it is a
 * property of this file.
 */

import './ui/styles/tokens.css';
import './ui/styles/base.css';
import './ui/styles/type.css';
import './ui/styles/layout.css';

import rawConfig from './config/restaurant.json';
import { validateRestaurantConfig } from './config/validate.js';
import { buildSeedDiary, toDiaryEntries } from './config/seed.js';
import { PUBLIC_CONFIG, hasGateway, LISTENING } from './config/settings.js';

import { systemClock, systemIds } from './agent/clock.js';
import { Orchestrator, type OrchestratorEvent, type TalkState } from './agent/orchestrator.js';
import { createRuleBrain } from './agent/brains/rule.js';
import { createLlmBrain } from './agent/brains/llm.js';
import type { Brain, BookingRepository, SpeechInput } from './agent/ports.js';
import type { ParseContext } from './agent/brains/parse/types.js';

import { GatewayClient } from './gateway/client.js';
import { getTurnstileToken, turnstileConfigured } from './gateway/turnstile.js';
import { openRepository } from './storage/repository.js';
import { createAudioQueue } from './speech/audio.js';
import { createVad, type Vad } from './speech/vad.js';
import { createSpeechInput } from './speech/asr/index.js';
import { createHostedSpeechInput } from './speech/asr/hosted.js';
import { SpeechCascade, PrebakedSpeech, HostedSpeech, createBrowserSpeechOutput } from './speech/tts/index.js';

import { createLiveRegions, onEscape } from './ui/a11y.js';
import { createTalkButton } from './ui/components/talk-button.js';
import { createTranscript } from './ui/components/transcript.js';
import { createSlotPanel } from './ui/components/slot-panel.js';
import { createListeningIndicator } from './ui/components/listening-indicator.js';
import { createLatencyReadout } from './ui/components/latency.js';
import { createModeTag } from './ui/components/mode-tag.js';
import { createTypeInput } from './ui/components/type-input.js';
import { createConfirmationCard } from './ui/components/confirmation.js';
import { createFallbackPanel } from './ui/components/fallback-panel.js';
import { createConversationView } from './ui/views/conversation.js';
import { createDiaryView } from './ui/views/diary.js';
import { createHowItWorks } from './ui/views/how-it-works.js';

import type { Booking, EngineDeps } from './engine/index.js';

/* --------------------------------------------------------- the last resort -- */

/**
 * Installed before anything else runs.
 *
 * Plan §7.5 F12 calls the fallback panel "the floor, and it is a designed
 * state". A floor installed after the thing it catches would be no floor at all,
 * so this is the first statement executed.
 */
function installFallback(): (message: string) => void {
  const host = document.getElementById('fallback');
  const panel = createFallbackPanel({ repositoryUrl: PUBLIC_CONFIG.repositoryUrl });
  host?.append(panel.el);

  const show = (message: string): void => {
    if (host === null) return;
    panel.update({ message });
    host.hidden = false;
  };

  window.addEventListener('error', () => show('Something in this page stopped working.'));
  window.addEventListener('unhandledrejection', () => show('Something in this page stopped working.'));

  return show;
}

/* ------------------------------------------------------------- selection -- */

/** The gateway, if this build was given one. */
function selectGateway(): GatewayClient | null {
  if (!hasGateway()) return null;
  return new GatewayClient();
}

/**
 * Recognition: browser first, hosted where the browser cannot, typing always.
 *
 * The hosted adapter is only offered when there is a gateway to reach; without
 * one, a Firefox visitor goes straight to typing rather than to a path that
 * cannot work (plan §7.5 F7/F8).
 */
async function selectSpeechInput(gateway: GatewayClient | null, locale: string): Promise<SpeechInput> {
  const hosted = gateway === null ? undefined : createHostedSpeechInput({ client: gateway, locale });
  return createSpeechInput({ locale, ...(hosted === undefined ? {} : { hosted }) });
}

/* ------------------------------------------------------------------ boot -- */

async function boot(): Promise<void> {
  const showFallback = installFallback();

  try {
    const config = validateRestaurantConfig(rawConfig);
    const locale = pickLocale(config.locales);
    document.documentElement.lang = locale;

    const clock = systemClock(config.timezone);
    const gateway = selectGateway();

    /* --- storage, seeded on first load ---------------------------------- */
    const today = clock.now().date;
    const repository: BookingRepository = await openRepository({
      seed: () => buildSeedDiary(config, today, clock.now().iso),
    });
    const bookings = await repository.listBookings();

    const deps: EngineDeps = {
      clock,
      config,
      diary: toDiaryEntries(bookings),
      ids: systemIds(),
      source: 'voice',
      brain: gateway === null ? 'rule' : 'mixed',
    };

    const parseContext = (): ParseContext => ({
      today: clock.now().date,
      nowTime: clock.now().time,
      config,
    });

    /* --- speech --------------------------------------------------------- */
    const audio = createAudioQueue();
    const speech = new SpeechCascade({
      prebaked: new PrebakedSpeech(),
      ...(gateway === null ? {} : { hosted: new HostedSpeech({ client: gateway }) }),
      browser: createBrowserSpeechOutput(),
      onSource: (source, ms) => latency.update({ ms: Math.round(ms), source }),
    });

    const input = await selectSpeechInput(gateway, locale);

    /* --- brains --------------------------------------------------------- */
    const ruleBrain: Brain = createRuleBrain({ context: parseContext });
    // `onFirstToken` cancels the pending filler the moment the model starts
    // producing, so a fast reply never gets "let me check" bolted onto the
    // front of it.
    //
    // Note what is *not* wired here: streaming the model's prose straight to
    // speech. In this architecture the engine emits the line for nearly every
    // turn and the engine's line wins (see `chooseSpokenLines`), so speaking the
    // model's tokens as they arrive would speak something that is then
    // superseded. The overlap mechanism therefore buys less here than it would
    // in a design where the model owns the wording — and the prebaked cache is
    // what actually carries the latency budget. `docs/latency.md` says so
    // rather than claiming the mechanism twice.
    const llmBrain =
      gateway === null
        ? undefined
        : createLlmBrain({ client: gateway, onFirstToken: () => orchestrator.cancelFiller() });

    /* --- UI ------------------------------------------------------------- */
    const live = createLiveRegions();

    const transcript = createTranscript();
    const slotPanel = createSlotPanel({ onAnnounce: (text) => live.announce(text) });
    const listeningIndicator = createListeningIndicator({ level: () => input.level() });
    const latency = createLatencyReadout();
    const modeTag = createModeTag();
    const typeInput = createTypeInput({ onSubmit: (text) => void orchestrator.handleTurn(text) });
    const confirmation = createConfirmationCard({ onViewDiary: () => showDiary() });

    const conversationView = createConversationView({
      transcript: transcript.el,
      listeningIndicator: listeningIndicator.el,
      slotPanel: slotPanel.el,
      latency: latency.el,
      modeTag: modeTag.el,
      typeInput: typeInput.el,
      confirmation: confirmation.el,
    });

    const diaryView = createDiaryView({ repository, onBack: () => showConversation() });
    const howItWorks = createHowItWorks();

    document.getElementById('conversation')?.append(conversationView.el);
    document.getElementById('diary')?.append(diaryView.el);
    document.getElementById('how-it-works')?.append(howItWorks.el);

    conversationView.update({ visible: false });
    typeInput.update({ visible: true, disabled: false });
    modeTag.update({
      ruleMode: gateway === null,
      ...(gateway === null
        ? { reason: 'This build has no AI gateway configured, so the built-in rules run the conversation.' }
        : {}),
    });

    /* --- the loop ------------------------------------------------------- */
    const orchestrator = new Orchestrator({
      deps,
      ruleBrain,
      ...(llmBrain === undefined ? {} : { llmBrain }),
      speech,
      audio,
      input,
      repository,
      parseContext,
      locale,
      onEvent: (event) => handleEvent(event),
    });

    function handleEvent(event: OrchestratorEvent): void {
      switch (event.type) {
        case 'state':
          slotPanel.update({
            slots: event.state.slots,
            slotStates: event.state.slotStates,
            today: clock.now().date,
          });
          return;

        case 'agent_line':
          transcript.addAgent(event.text);
          live.log(event.text);
          return;

        case 'visitor_interim':
          transcript.setInterim(event.text);
          return;

        case 'visitor_final':
          transcript.addVisitor(event.text);
          return;

        case 'phase':
          talkButton.update({ state: event.phase });
          listeningIndicator.update({ active: isActive(event.phase), state: event.phase });
          return;

        case 'latency':
          latency.update({ ms: event.ms });
          return;

        case 'mode':
          modeTag.update({ ruleMode: event.ruleMode });
          if (event.ruleMode) live.announce('Simple mode');
          return;

        case 'slot':
          return;

        case 'offer_typing':
          typeInput.update({ visible: true, disabled: false, label: 'Type your reply' });
          live.error('The microphone is unavailable. You can type instead.');
          return;

        case 'booked':
          void onBooked(event.booking);
          return;

        case 'ended':
          talkButton.update({ state: 'idle' });
          return;

        default:
          return;
      }
    }

    async function onBooked(booking: Booking): Promise<void> {
      // The card takes focus itself inside `update`, and remembers where focus
      // came from. Moving it a second time here would capture the card as its
      // own "previous", so the eventual restore would hand focus back to the
      // card rather than to the Talk button.
      confirmation.update({ booking });
      live.announce(`Booked. Reference ${booking.reference.split('').join(' ')}`);
      await refreshDiary(booking.id);
    }

    async function refreshDiary(highlightId?: string): Promise<void> {
      const [all, transcripts] = await Promise.all([repository.listBookings(), repository.listTranscripts()]);
      diaryView.update({
        bookings: all,
        transcripts,
        ...(highlightId === undefined ? {} : { highlightId }),
        today: clock.now().date,
        // F10: private browsing falls back to an in-memory store. The visitor
        // should be told once, quietly, rather than discovering it on refresh.
        persistent: repository.persistent,
      });
    }

    const talkButton = createTalkButton({
      onPress: () => void start(),
      onInterrupt: () => orchestrator.interrupt(),
    });

    // The hero's button is already in the HTML so that it paints with the rest
    // of the page. The component takes it over rather than replacing it, which
    // keeps the markup honest and avoids a visible swap on hydration.
    const heroButton = document.getElementById('talk');
    heroButton?.replaceWith(talkButton.el);

    let started = false;
    async function start(): Promise<void> {
      if (started) {
        orchestrator.interrupt();
        return;
      }
      started = true;
      conversationView.update({ visible: true });
      document.getElementById('conversation')?.removeAttribute('hidden');

      // The gateway will not issue a session without a Turnstile token, and
      // without a session there is no model and no neural voice. This is the
      // one place that happens, and it happens on a user gesture because that
      // is when a bot check is meaningful and when the script is worth loading.
      //
      // Every failure below is silent by design: no session means the rule
      // brain and the browser's own voice, which is a complete experience
      // (plan §7.5 F1). The visitor sees a `simple mode` tag and nothing else.
      if (gateway !== null) {
        const established = await establishSession(gateway);
        if (!established) {
          orchestrator.forceRuleMode();
          modeTag.update({ ruleMode: true, reason: 'The AI host is unavailable right now.' });
        }
      }

      await orchestrator.begin();
      void attachBargeIn();

      // F11: some browsers refuse to resume an audio context even on a gesture.
      // Silence with no explanation reads as broken, so the visitor is offered
      // the tap the browser is waiting for. The conversation continues on
      // screen either way.
      if (!audio.isUnlocked()) offerSoundTap();
    }

    function offerSoundTap(): void {
      if (document.getElementById('enable-sound') !== null) return;

      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'enable-sound';
      button.className = 'linkish';
      button.textContent = 'Tap to enable sound';
      button.addEventListener('click', () => {
        void audio.unlock().then(() => {
          if (audio.isUnlocked()) button.remove();
        });
      });

      conversationView.el.prepend(button);
      live.error('Your browser has not allowed sound yet. Tap to enable it.');
    }

    /**
     * Energy-based barge-in (R-22, T-085).
     *
     * Web Speech gives no access to the audio it consumes, so this opens its own
     * microphone stream. Permission has already been granted by this point, so
     * it costs no second prompt — and without it, barge-in would need a key
     * press or a tap, which is not what "talk over it" means.
     *
     * Honest limitation, also stated in the README: this measures loudness, not
     * speech. In a noisy room it will fire on something that is not the visitor.
     * A trained voice-activity model would cost several hundred KB of WASM that
     * the 2MB budget does not have.
     */
    let vad: Vad | null = null;
    async function attachBargeIn(): Promise<void> {
      if (vad !== null) return;
      try {
        const AudioCtor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
        if (AudioCtor === undefined || navigator.mediaDevices === undefined) return;

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        vad = createVad(stream, new AudioCtor(), () => orchestrator.onMicrophoneEnergy());
      } catch {
        // No microphone, or permission refused. `Esc` and the Talk button remain
        // as barge-in, and the typed path is unaffected.
      }
    }

    async function establishSession(client: GatewayClient): Promise<boolean> {
      try {
        const health = await client.health();
        if (health.mode !== 'full') return false;
        if (!turnstileConfigured()) return false;

        const token = await getTurnstileToken();
        if (token === null) return false;

        await client.ensureSession(token);
        return true;
      } catch {
        return false;
      }
    }

    function showDiary(): void {
      document.getElementById('diary')?.removeAttribute('hidden');
      document.getElementById('diary')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      confirmation.restoreFocus();
    }

    function showConversation(): void {
      document.getElementById('conversation')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /* --- page chrome ---------------------------------------------------- */
    wireHeroLinks(() => {
      typeInput.update({ visible: true, disabled: false, label: 'Type your reply' });
      conversationView.update({ visible: true });
      document.getElementById('conversation')?.removeAttribute('hidden');
    });

    // `Esc` interrupts. Barge-in must not require a microphone (plan §14).
    onEscape(() => orchestrator.interrupt());

    await refreshDiary();
    if (bookings.some((b) => !b.seeded)) document.getElementById('diary')?.removeAttribute('hidden');

    /* --- warm up while the hero is being read (R-24) --------------------- */
    scheduleIdle(() => {
      void orchestrator.warm();
      void gateway?.warm();
    });

    // The "warming up" label only appears if readiness is genuinely slow
    // (plan §4.5). Most of the time nobody ever sees it.
    const warmingTimer = setTimeout(() => talkButton.update({ state: 'warming' }), 800);
    void orchestrator.warm().finally(() => {
      clearTimeout(warmingTimer);
      talkButton.update({ state: 'idle' });
    });
  } catch (error: unknown) {
    showFallback('This page could not start up.');
    // Rethrowing would only hit the handler that already ran. The panel is on
    // screen, which is the outcome that matters.
    if (error instanceof Error && import.meta.env?.DEV === true) console.error(error);
  }
}

/* --------------------------------------------------------------- helpers -- */

function isActive(state: TalkState): boolean {
  return state === 'listening' || state === 'thinking';
}

/** The browser's preference, if the restaurant supports it (plan §0, A4). */
function pickLocale(supported: readonly string[]): string {
  const preferred = navigator.languages ?? [navigator.language];
  for (const candidate of preferred) {
    const match = supported.find((s) => s.toLowerCase() === candidate.toLowerCase());
    if (match !== undefined) return match;
  }
  return supported[0] ?? 'en-IN';
}

/** `requestIdleCallback` where it exists, a timeout where it does not. */
function scheduleIdle(work: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (typeof idle === 'function') idle(work);
  else setTimeout(work, LISTENING.endpointSilenceMs);
}

/** The two links under the Talk button, wired without a framework. */
function wireHeroLinks(onTypeInstead: () => void): void {
  document.getElementById('type-instead')?.addEventListener('click', onTypeInstead);

  const toggle = document.getElementById('privacy-toggle');
  const note = document.getElementById('privacy');
  toggle?.addEventListener('click', () => {
    if (note === null) return;
    const open = note.hasAttribute('hidden');
    if (open) note.removeAttribute('hidden');
    else note.setAttribute('hidden', '');
    toggle.setAttribute('aria-expanded', String(open));
  });
}

void boot();
