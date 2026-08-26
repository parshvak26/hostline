/**
 * What happened comes before how it sounds.
 *
 * The orchestrator used to `await speakAll(...)` before emitting `booked` and
 * saving the booking. On any machine with working audio that is invisible. On
 * one without — a CI runner with no speech service, a browser with no installed
 * voices — `speechSynthesis` never fires `onend`, and the visitor's
 * confirmation card sits hidden behind an `await` that is waiting on a speaker
 * nobody can hear.
 *
 * That cost twenty-three end-to-end tests, and it would have cost a real
 * visitor their booking confirmation. The rule it broke is worth stating
 * plainly: **speech is the one part of a turn that depends on a platform we do
 * not control, so nothing the visitor needs may be sequenced behind it.**
 */

import { describe, expect, it, vi } from 'vitest';

import { Orchestrator, type OrchestratorEvent } from '../../src/agent/orchestrator.js';
import { createRuleBrain } from '../../src/agent/brains/rule.js';
import type { AudioQueue, BookingRepository, SpeechOutput, Transcript } from '../../src/agent/ports.js';
import type { Booking } from '../../src/engine/index.js';
import { SPEECH } from '../../src/config/settings.js';
import { CONFIG, TODAY, makeDeps } from '../helpers/engine.js';

/** A speaker that never finishes, which is the failure this file is about. */
function wedgedSpeech(): SpeechOutput {
  return {
    kind: 'cascade',
    async resolve() {
      return new Promise(() => undefined);
    },
    async speak() {
      return new Promise(() => undefined);
    },
    cancel: () => undefined,
  };
}

function silentAudio(): AudioQueue {
  return {
    unlock: async () => undefined,
    isUnlocked: () => true,
    enqueue: async () => undefined,
    flush: () => undefined,
    isPlaying: () => false,
    onEnded: () => () => undefined,
  };
}

function memoryRepository(): BookingRepository & { saved: Booking[] } {
  const saved: Booking[] = [];
  return {
    kind: 'memory',
    persistent: false,
    saved,
    init: async () => undefined,
    listBookings: async () => [...saved],
    saveBooking: async (booking: Booking) => {
      saved.push(booking);
    },
    saveTranscript: async (_transcript: Transcript) => undefined,
    listTranscripts: async () => [],
    clear: async () => {
      saved.length = 0;
    },
  };
}

function build(speech: SpeechOutput) {
  const events: OrchestratorEvent[] = [];
  const repository = memoryRepository();
  const deps = makeDeps();

  const orchestrator = new Orchestrator({
    deps,
    ruleBrain: createRuleBrain({
      context: () => ({ today: TODAY, nowTime: '18:00', config: CONFIG }),
    }),
    speech,
    audio: silentAudio(),
    repository,
    parseContext: () => ({ today: TODAY, nowTime: '18:00', config: CONFIG }),
    onEvent: (event) => events.push(event),
  });

  return { orchestrator, events, repository };
}

const BOOKING_TURNS = [
  'a table for two on friday',
  'half seven',
  'under Priya',
  '9820011234',
  'yes please',
] as const;

/** Walk a whole booking through the turn loop. */
async function bookATable(orchestrator: Orchestrator): Promise<void> {
  for (const turn of BOOKING_TURNS) await orchestrator.handleTurn(turn);
}

describe('a turn does not wait on the speaker', () => {
  it('emits the booking and saves it even when speech never finishes', async () => {
    // Fake timers, because the point is to reach the speech ceiling on every
    // turn without spending a real minute doing it.
    vi.useFakeTimers();
    try {
      const { orchestrator, events, repository } = build(wedgedSpeech());

      for (const turn of BOOKING_TURNS) {
        const pending = orchestrator.handleTurn(turn);
        await vi.advanceTimersByTimeAsync(SPEECH.turnSpeechCeilingMs + 500);
        await pending;
      }

      // No audio ever completed. The booking still exists, on screen and stored.
      expect(repository.saved).toHaveLength(1);
      expect(events.some((event) => event.type === 'booked')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('emits `booked` before it starts speaking, not after', async () => {
    // The ordering asserted directly, on one shared timeline: the speaker and
    // the event stream both append to the same array, so their interleaving is
    // the thing under test rather than something inferred from it.
    const timeline: string[] = [];

    const speech: SpeechOutput = {
      kind: 'cascade',
      async resolve() {
        timeline.push('speak');
        return { source: 'browser', audio: null, resolvedInMs: 1 };
      },
      async speak() {
        return undefined;
      },
      cancel: () => undefined,
    };

    const repository = memoryRepository();
    const orchestrator = new Orchestrator({
      deps: makeDeps(),
      ruleBrain: createRuleBrain({
        context: () => ({ today: TODAY, nowTime: '18:00', config: CONFIG }),
      }),
      speech,
      audio: silentAudio(),
      repository,
      parseContext: () => ({ today: TODAY, nowTime: '18:00', config: CONFIG }),
      onEvent: (event) => {
        if (event.type === 'booked') timeline.push('booked');
      },
    });

    await bookATable(orchestrator);

    const booked = timeline.indexOf('booked');
    expect(booked).toBeGreaterThanOrEqual(0);

    // Every line spoken on the committing turn comes after the announcement.
    // Before the fix, `booked` was last.
    expect(timeline.lastIndexOf('speak')).toBeGreaterThan(booked);
  }, 30_000);
});
