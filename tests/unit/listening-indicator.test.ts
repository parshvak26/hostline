// @vitest-environment jsdom
/**
 * Listening indicator (T-101).
 *
 * Two properties matter more than the drawing, and both are the kind that fail
 * silently in a browser:
 *
 *   1. **The word, not the picture, is the status.** It lives in a
 *      `role="status"` region and is written only when the state actually
 *      changes. Rewriting it every frame would be invisible on screen and
 *      unusable through a screen reader, so the "unchanged props" case is
 *      asserted directly rather than assumed.
 *   2. **Reduced motion means no loop at all**, not a slower one. The assertion
 *      is that `requestAnimationFrame` is never called — a component that
 *      schedules a frame and then declines to move things is still burning a
 *      frame budget on a machine whose owner asked it not to.
 *
 * The rAF stub keeps the last callback the component scheduled and replays it
 * with explicit timestamps, so smoothing and scroll cadence are exercised at a
 * fixed frame rate instead of whatever jsdom feels like.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createListeningIndicator } from '../../src/ui/components/listening-indicator.js';

/* ---------------------------------------------------------------- stubs -- */

function stubMotion(reduced: boolean): {
  readonly query: { matches: boolean; addEventListener: unknown; removeEventListener: unknown };
  set(next: boolean): void;
  listenerCount(): number;
} {
  const listeners = new Set<() => void>();
  const query = {
    matches: reduced,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn((_type: string, fn: () => void) => {
      listeners.add(fn);
    }),
    removeEventListener: vi.fn((_type: string, fn: () => void) => {
      listeners.delete(fn);
    }),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => query));
  return {
    query,
    set(next: boolean): void {
      query.matches = next;
      for (const fn of [...listeners]) fn();
    },
    listenerCount: (): number => listeners.size,
  };
}

/** The one DOM type this file needs, spelled out rather than imported. */
type Frame = (now: number) => void;

const FRAME_MS = 16;

function stubFrames(): {
  raf: ReturnType<typeof vi.fn>;
  caf: ReturnType<typeof vi.fn>;
  advance(count: number): void;
} {
  // A cancelled callback really is gone, and the clock only moves forward.
  // Both matter: the component derives its smoothing from the frame delta, so
  // a harness that replays timestamps would drive it backwards.
  let pending = new Map<number, Frame>();
  let nextId = 0;
  let clock = 0;

  const raf = vi.fn((fn: Frame) => {
    nextId += 1;
    pending.set(nextId, fn);
    return nextId;
  });
  const caf = vi.fn((id: number) => {
    pending.delete(id);
  });
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('cancelAnimationFrame', caf);

  return {
    raf,
    caf,
    advance(count: number): void {
      for (let i = 0; i < count; i += 1) {
        clock += FRAME_MS;
        const entries = [...pending];
        const latest = entries.at(-1);
        pending = new Map();
        if (latest !== undefined) latest[1](clock);
      }
    },
  };
}

function statusOf(root: HTMLElement): HTMLElement {
  const node = root.querySelector('[role="status"]');
  if (!(node instanceof HTMLElement)) throw new Error('no role="status" element');
  return node;
}

function pointsOf(root: HTMLElement): string {
  return root.querySelector('polyline')?.getAttribute('points') ?? '';
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------- accessible text -- */

describe('accessible status', () => {
  it('carries the state as text inside a role="status" element', () => {
    stubMotion(true);
    const indicator = createListeningIndicator({ level: () => 0 });

    indicator.update({ active: true, state: 'listening' });
    expect(statusOf(indicator.el).textContent).toBe('Listening');

    indicator.update({ active: true, state: 'thinking' });
    expect(statusOf(indicator.el).textContent).toBe('Thinking');

    indicator.update({ active: true, state: 'speaking' });
    expect(statusOf(indicator.el).textContent).toBe('Speaking');
  });

  it('says nothing while inactive, so an unused indicator is not announced', () => {
    stubMotion(true);
    const indicator = createListeningIndicator({ level: () => 0 });

    expect(statusOf(indicator.el).textContent).toBe('');
    indicator.update({ active: false, state: 'listening' });
    expect(statusOf(indicator.el).textContent).toBe('');
  });

  it('does not rewrite the status when the state is unchanged', () => {
    stubMotion(true);
    const indicator = createListeningIndicator({ level: () => 0 });
    indicator.update({ active: true, state: 'listening' });

    // A sentinel survives only if nothing wrote to the node. Repeated identical
    // updates are normal — the orchestrator pushes props on every turn event.
    const status = statusOf(indicator.el);
    status.textContent = 'sentinel';
    indicator.update({ active: true, state: 'listening' });
    indicator.update({ active: true, state: 'listening' });
    expect(status.textContent).toBe('sentinel');

    indicator.update({ active: true, state: 'thinking' });
    expect(status.textContent).toBe('Thinking');
  });

  it('hides the drawing from assistive technology', () => {
    stubMotion(true);
    const indicator = createListeningIndicator({ level: () => 0 });
    const svg = indicator.el.querySelector('svg');

    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('focusable')).toBe('false');
  });
});

/* --------------------------------------------------------- reduced motion -- */

describe('reduced motion', () => {
  it('never schedules a frame', () => {
    stubMotion(true);
    const frames = stubFrames();
    const indicator = createListeningIndicator({ level: () => 0.5 });

    indicator.update({ active: true, state: 'listening' });
    indicator.update({ active: true, state: 'thinking' });
    indicator.update({ active: true, state: 'speaking' });

    expect(frames.raf).not.toHaveBeenCalled();
  });

  it('renders a still shape that differs per state', () => {
    stubMotion(true);
    stubFrames();
    const indicator = createListeningIndicator({ level: () => 0.5 });

    indicator.update({ active: true, state: 'listening' });
    const listening = pointsOf(indicator.el);

    indicator.update({ active: true, state: 'thinking' });
    const thinking = pointsOf(indicator.el);

    indicator.update({ active: true, state: 'idle' });
    const idle = pointsOf(indicator.el);

    expect(listening).not.toBe('');
    expect(listening).not.toBe(thinking);
    expect(thinking).not.toBe(idle);
    expect(listening).not.toBe(idle);
  });

  it('stops an already running loop when the preference is turned on', () => {
    const motion = stubMotion(false);
    const frames = stubFrames();
    const indicator = createListeningIndicator({ level: () => 0.5 });

    indicator.update({ active: true, state: 'listening' });
    expect(frames.raf).toHaveBeenCalledTimes(1);

    motion.set(true);
    expect(frames.caf).toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------- the loop -- */

describe('the frame loop', () => {
  it('runs while active and listening, and not before', () => {
    stubMotion(false);
    const frames = stubFrames();
    const indicator = createListeningIndicator({ level: () => 0.2 });

    expect(frames.raf).not.toHaveBeenCalled();
    indicator.update({ active: true, state: 'listening' });
    expect(frames.raf).toHaveBeenCalledTimes(1);
  });

  it('stops when active goes false', () => {
    stubMotion(false);
    const frames = stubFrames();
    const indicator = createListeningIndicator({ level: () => 0.2 });

    indicator.update({ active: true, state: 'listening' });
    frames.advance(3);
    frames.caf.mockClear();

    indicator.update({ active: false, state: 'listening' });
    expect(frames.caf).toHaveBeenCalled();

    const before = frames.raf.mock.calls.length;
    frames.advance(5);
    expect(frames.raf.mock.calls.length).toBe(before);
  });

  it('does not run in the quiet states', () => {
    stubMotion(false);
    const frames = stubFrames();
    const indicator = createListeningIndicator({ level: () => 0.2 });

    indicator.update({ active: true, state: 'idle' });
    indicator.update({ active: true, state: 'warming' });
    indicator.update({ active: true, state: 'speaking' });

    expect(frames.raf).not.toHaveBeenCalled();
  });

  it('cancels the frame and drops the media listener on destroy', () => {
    const motion = stubMotion(false);
    const frames = stubFrames();
    const indicator = createListeningIndicator({ level: () => 0.2 });

    indicator.update({ active: true, state: 'listening' });
    expect(motion.listenerCount()).toBe(1);

    indicator.destroy?.();
    expect(frames.caf).toHaveBeenCalled();
    expect(motion.query.removeEventListener).toHaveBeenCalled();
    expect(motion.listenerCount()).toBe(0);
  });
});

/* ---------------------------------------------------------- real input -- */

describe('microphone input', () => {
  it('consults level() on every frame while listening', () => {
    stubMotion(false);
    const frames = stubFrames();
    const level = vi.fn(() => 0.05);
    const indicator = createListeningIndicator({ level });

    indicator.update({ active: true, state: 'listening' });
    expect(level).not.toHaveBeenCalled();

    frames.advance(4);
    expect(level).toHaveBeenCalledTimes(4);
  });

  it('changes the drawn geometry between a quiet room and a loud one', () => {
    stubMotion(false);
    const frames = stubFrames();
    let rms = 0;
    const indicator = createListeningIndicator({ level: () => rms });

    indicator.update({ active: true, state: 'listening' });
    frames.advance(10);
    const quiet = pointsOf(indicator.el);

    rms = 0.9;
    frames.advance(10);
    const loud = pointsOf(indicator.el);

    expect(quiet).not.toBe('');
    expect(loud).not.toBe(quiet);
  });

  it('sits still while the room is quiet', () => {
    stubMotion(false);
    const frames = stubFrames();
    // Below the noise floor. Room tone must not draw anything.
    const indicator = createListeningIndicator({ level: () => 0.004 });

    indicator.update({ active: true, state: 'listening' });
    frames.advance(5);
    const first = pointsOf(indicator.el);
    frames.advance(30);

    expect(pointsOf(indicator.el)).toBe(first);
  });

  it('ignores a non-finite level rather than drawing NaN', () => {
    stubMotion(false);
    const frames = stubFrames();
    const indicator = createListeningIndicator({ level: () => Number.NaN });

    indicator.update({ active: true, state: 'listening' });
    frames.advance(5);

    expect(pointsOf(indicator.el)).not.toContain('NaN');
  });

  it('animates thinking without consulting the microphone', () => {
    stubMotion(false);
    const frames = stubFrames();
    const level = vi.fn(() => 0.4);
    const indicator = createListeningIndicator({ level });

    indicator.update({ active: true, state: 'thinking' });
    frames.advance(3);
    const early = pointsOf(indicator.el);
    frames.advance(20);

    expect(level).not.toHaveBeenCalled();
    expect(pointsOf(indicator.el)).not.toBe(early);
  });
});

/* ------------------------------------------------------------- markup -- */

describe('markup', () => {
  it('reflects state and activity as attributes the stylesheet can key on', () => {
    stubMotion(true);
    const indicator = createListeningIndicator({ level: () => 0 });

    indicator.update({ active: true, state: 'speaking' });
    expect(indicator.el.getAttribute('data-state')).toBe('speaking');
    expect(indicator.el.getAttribute('data-active')).toBe('true');

    indicator.update({ active: false, state: 'idle' });
    expect(indicator.el.getAttribute('data-active')).toBe('false');
  });

  it('builds the trace once and mutates it, rather than replacing nodes', () => {
    stubMotion(false);
    const frames = stubFrames();
    let rms = 0.1;
    const indicator = createListeningIndicator({ level: () => rms });
    const trace = indicator.el.querySelector('polyline');

    indicator.update({ active: true, state: 'listening' });
    frames.advance(6);
    rms = 0.6;
    frames.advance(6);

    expect(indicator.el.querySelector('polyline')).toBe(trace);
    expect(indicator.el.querySelectorAll('polyline').length).toBe(1);
  });
});
