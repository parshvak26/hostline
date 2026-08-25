// @vitest-environment jsdom
/**
 * The conversation chrome (T-048, T-087).
 *
 * These five components are the whole interface most visitors touch, and the
 * properties asserted here are the ones that are easy to regress and expensive
 * to lose: the button's state never being carried by colour alone, the
 * transcript announcing exactly once, interim text being replaced rather than
 * piled up, and the typed path working with no microphone anywhere in sight.
 *
 * The copy assertion at the bottom is not decoration. Plan §5.4 forbids
 * exclamation marks, and a single chirpy label is enough to change what the
 * whole page sounds like.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TalkState } from '../../src/agent/orchestrator.js';
import type { TranscriptTurn } from '../../src/agent/ports.js';
import { createLatencyReadout } from '../../src/ui/components/latency.js';
import { createModeTag } from '../../src/ui/components/mode-tag.js';
import { createTalkButton } from '../../src/ui/components/talk-button.js';
import { createTranscript } from '../../src/ui/components/transcript.js';
import { createTypeInput } from '../../src/ui/components/type-input.js';

const STATES: readonly TalkState[] = ['idle', 'warming', 'listening', 'thinking', 'speaking'];

/** What a screen reader would read out, in the order it resolves the name. */
function accessibleName(element: HTMLElement): string {
  return element.getAttribute('aria-label') ?? element.textContent ?? '';
}

function turn(role: TranscriptTurn['role'], text: string): TranscriptTurn {
  return { role, text, at: '2025-08-25T12:00:00.000Z' };
}

/** Record every write to `scrollTop`; jsdom has no layout, so nothing else can. */
function watchScroll(element: HTMLElement): number[] {
  const writes: number[] = [];
  let current = 0;
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => current,
    set: (value: number) => {
      current = value;
      writes.push(value);
    },
  });
  return writes;
}

function setReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  }));
}

beforeEach(() => {
  document.body.replaceChildren();
  setReducedMotion(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------ talk button - */

describe('talk button', () => {
  function make(): {
    button: HTMLElement;
    press: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
    update: (state: TalkState) => void;
  } {
    const press = vi.fn();
    const interrupt = vi.fn();
    const component = createTalkButton({
      onPress: press,
      onInterrupt: interrupt,
      element: document.createElement('button'),
    });
    return {
      button: component.el,
      press,
      interrupt,
      update: (state) => component.update({ state }),
    };
  }

  it('starts idle with the resting label and data-state', () => {
    const { button } = make();
    expect(button.textContent).toBe('Talk to us');
    expect(button.dataset['state']).toBe('idle');
  });

  it('gives every state a distinct visible label', () => {
    const { button, update } = make();
    const labels = STATES.map((state) => {
      update(state);
      return button.textContent;
    });
    expect(new Set(labels).size).toBe(STATES.length);
  });

  it('gives every state a distinct accessible name', () => {
    const { button, update } = make();
    const names = STATES.map((state) => {
      update(state);
      return accessibleName(button);
    });
    expect(new Set(names).size).toBe(STATES.length);
  });

  it('keeps the visible label inside the accessible name', () => {
    const { button, update } = make();
    for (const state of STATES) {
      update(state);
      expect(accessibleName(button)).toContain(button.textContent ?? '');
    }
  });

  it('mirrors the state onto data-state for CSS and e2e', () => {
    const { button, update } = make();
    for (const state of STATES) {
      update(state);
      expect(button.dataset['state']).toBe(state);
    }
  });

  it('labels the speaking state as an interrupt', () => {
    const { button, update } = make();
    update('speaking');
    expect(button.textContent).toBe('Tap to interrupt');
  });

  it('calls onPress and not onInterrupt while idle', () => {
    const { button, press, interrupt } = make();
    button.click();
    expect(press).toHaveBeenCalledTimes(1);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('calls onInterrupt and not onPress while speaking', () => {
    const { button, press, interrupt, update } = make();
    update('speaking');
    button.click();
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(press).not.toHaveBeenCalled();
  });

  it('takes over the hero button rather than replacing the node', () => {
    // The skip-link targets #talk and the hero paints before any script runs,
    // so the element has to survive being wired up.
    const existing = document.createElement('button');
    existing.id = 'talk';
    document.body.append(existing);

    const component = createTalkButton({ onPress: vi.fn(), onInterrupt: vi.fn() });

    expect(component.el).toBe(existing);
    expect(document.getElementById('talk')).toBe(existing);
    expect(component.el.textContent).toBe('Talk to us');
  });

  it('stops calling back after destroy', () => {
    const press = vi.fn();
    const component = createTalkButton({
      onPress: press,
      onInterrupt: vi.fn(),
      element: document.createElement('button'),
    });
    component.destroy?.();
    component.el.click();
    expect(press).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------- transcript - */

describe('transcript', () => {
  it('gives agent and visitor turns different classes', () => {
    const transcript = createTranscript();
    transcript.addAgent('Good evening.');
    transcript.addVisitor('A table for two.');

    const [agent, visitor] = Array.from(transcript.el.children);
    expect(agent?.className).toContain('transcript__turn--agent');
    expect(visitor?.className).toContain('transcript__turn--visitor');
    expect(agent?.className).not.toBe(visitor?.className);
  });

  it('replaces interim text in place instead of appending', () => {
    const transcript = createTranscript();
    transcript.setInterim('a table');
    transcript.setInterim('a table for');
    transcript.setInterim('a table for two');

    expect(transcript.el.querySelectorAll('.transcript__turn')).toHaveLength(1);
    expect(transcript.el.textContent).toBe('a table for two');
  });

  it('promotes the interim node when the final text arrives', () => {
    const transcript = createTranscript();
    transcript.setInterim('a table for');
    const interimNode = transcript.el.querySelector('.transcript__turn--interim');
    transcript.addVisitor('A table for two.');

    const turns = transcript.el.querySelectorAll('.transcript__turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toBe(interimNode);
    expect(turns[0]?.className).not.toContain('interim');
    expect(turns[0]?.textContent).toBe('A table for two.');
  });

  it('keeps finished turns above the unsettled one', () => {
    const transcript = createTranscript();
    transcript.setInterim('for two');
    transcript.addAgent('Which evening?');

    const classes = Array.from(transcript.el.children, (node) => node.className);
    expect(classes[0]).toContain('--agent');
    expect(classes[1]).toContain('--interim');
  });

  it('clears the interim node when the interim text empties', () => {
    const transcript = createTranscript();
    transcript.setInterim('umm');
    transcript.setInterim('');
    expect(transcript.el.querySelectorAll('.transcript__turn')).toHaveLength(0);
  });

  it('renders markup as text and creates no script element', () => {
    const transcript = createTranscript();
    transcript.addVisitor('<script>alert("x")</script> <img src=x onerror=1>');

    expect(transcript.el.querySelector('script')).toBeNull();
    expect(transcript.el.querySelector('img')).toBeNull();
    expect(transcript.el.textContent).toContain('<script>');
  });

  it('is a log that defers announcing to the shared live region', () => {
    // src/ui/a11y.ts already announces every turn once. A polite region here
    // as well would read each turn twice, over the agent's own audio.
    const transcript = createTranscript();
    expect(transcript.el.getAttribute('role')).toBe('log');
    expect(transcript.el.getAttribute('aria-live')).toBe('off');
  });

  it('hides unsettled text from assistive technology', () => {
    const transcript = createTranscript();
    transcript.setInterim('a table for');
    expect(transcript.el.querySelector('.transcript__turn--interim')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('follows the newest turn when motion is allowed', () => {
    const transcript = createTranscript();
    const writes = watchScroll(transcript.el);
    transcript.addAgent('Good evening.');
    expect(writes.length).toBeGreaterThan(0);
  });

  it('does not auto-scroll under prefers-reduced-motion', () => {
    setReducedMotion(true);
    // jsdom ships no scrollIntoView, so the assertion needs one to watch.
    const scrolledIntoView: string[] = [];
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: function scrollIntoViewStub(this: Element): void {
        scrolledIntoView.push(this.className);
      },
    });

    try {
      const transcript = createTranscript();
      const writes = watchScroll(transcript.el);
      transcript.addAgent('Good evening.');
      transcript.setInterim('a table');
      transcript.addVisitor('A table for two.');

      expect(writes).toHaveLength(0);
      expect(transcript.el.scrollTop).toBe(0);
      expect(scrolledIntoView).toHaveLength(0);
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('renders a turn list passed as props, in order', () => {
    const transcript = createTranscript();
    transcript.update({ turns: [turn('agent', 'Good evening.'), turn('visitor', 'Two, please.')] });

    const turns = transcript.el.querySelectorAll('.transcript__turn');
    expect(turns).toHaveLength(2);
    expect(turns[0]?.className).toContain('--agent');
    expect(turns[1]?.textContent).toBe('Two, please.');
  });

  it('appends only the new turns when props extend the rendered list', () => {
    const transcript = createTranscript();
    const first = turn('agent', 'Good evening.');
    transcript.update({ turns: [first] });
    const rendered = transcript.el.firstElementChild;

    transcript.update({ turns: [first, turn('visitor', 'Two, please.')] });

    expect(transcript.el.firstElementChild).toBe(rendered);
    expect(transcript.el.querySelectorAll('.transcript__turn')).toHaveLength(2);
  });

  it('rebuilds when the turn list is replaced wholesale', () => {
    const transcript = createTranscript();
    transcript.update({ turns: [turn('agent', 'Good evening.')] });
    transcript.update({ turns: [turn('agent', 'Welcome back.')] });

    const turns = transcript.el.querySelectorAll('.transcript__turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]?.textContent).toBe('Welcome back.');
  });
});

/* ------------------------------------------------------------- type input - */

describe('type input', () => {
  function make(): { form: HTMLFormElement; field: HTMLInputElement; submitted: string[] } {
    const submitted: string[] = [];
    const component = createTypeInput({ onSubmit: (text) => submitted.push(text) });
    const form = component.el as HTMLFormElement;
    const field = form.querySelector('input');
    if (field === null) throw new Error('the typed path must have an input');
    document.body.append(form);
    return { form, field, submitted };
  }

  it('submits the trimmed text and clears the field', () => {
    const { form, field, submitted } = make();
    field.value = '  a table for two  ';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    expect(submitted).toEqual(['a table for two']);
    expect(field.value).toBe('');
  });

  it('ignores an empty submission', () => {
    const { form, field, submitted } = make();
    field.value = '   ';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    expect(submitted).toEqual([]);
  });

  it('associates a real label with the field', () => {
    const { form, field } = make();
    const label = form.querySelector('label');
    expect(field.id).not.toBe('');
    expect(label?.getAttribute('for')).toBe(field.id);
    expect(label?.textContent).not.toBe('');
  });

  it('offers a submit button so the path needs no microphone', () => {
    const { form } = make();
    const send = form.querySelector('button');
    expect(send?.getAttribute('type')).toBe('submit');
  });

  it('honours visibility, disabling and a label override', () => {
    const submitted: string[] = [];
    const component = createTypeInput({ onSubmit: (text) => submitted.push(text) });
    const form = component.el as HTMLFormElement;

    component.update({ visible: true, disabled: false, label: 'Your name' });
    expect(form.hidden).toBe(false);
    expect(form.querySelector('label')?.textContent).toBe('Your name');

    component.update({ visible: false, disabled: true });
    expect(form.hidden).toBe(true);
    expect(form.querySelector('input')?.disabled).toBe(true);
    expect(form.querySelector('button')?.disabled).toBe(true);
  });
});

/* ---------------------------------------------------------------- latency - */

describe('latency readout', () => {
  it('stays hidden until something has been measured', () => {
    const latency = createLatencyReadout();
    expect(latency.el.hidden).toBe(true);
    latency.update({ ms: 0 });
    expect(latency.el.hidden).toBe(true);
  });

  it('shows the measurement in milliseconds once there is one', () => {
    const latency = createLatencyReadout();
    latency.update({ ms: 840.4 });
    expect(latency.el.hidden).toBe(false);
    expect(latency.el.textContent).toContain('last reply 840 ms');
  });

  it('names the source when one is given', () => {
    const latency = createLatencyReadout();
    latency.update({ ms: 320, source: 'rule' });
    expect(latency.el.textContent).toContain('rule');
  });

  it('carries no colour-bearing class, because it is a fact and not a score', () => {
    const latency = createLatencyReadout();
    latency.update({ ms: 2400 });
    const classes = Array.from(latency.el.querySelectorAll('*'), (node) => node.className).join(' ');
    expect(`${latency.el.className} ${classes}`).not.toMatch(/ok|good|bad|warn|error|slow|fast|success|danger/i);
  });

  it('explains what it measures, in a tooltip and on the page', () => {
    const latency = createLatencyReadout();
    latency.update({ ms: 840 });
    expect(latency.el.getAttribute('title')).toContain('first sound of the reply');
    expect(latency.el.textContent).toContain('first sound of the reply');
  });
});

/* --------------------------------------------------------------- mode tag - */

describe('mode tag', () => {
  it('is hidden outside rule mode', () => {
    const tag = createModeTag();
    expect(tag.el.hidden).toBe(true);
    tag.update({ ruleMode: false });
    expect(tag.el.hidden).toBe(true);
  });

  it('names the mode and explains the limit in rule mode', () => {
    const tag = createModeTag();
    tag.update({ ruleMode: true });
    expect(tag.el.hidden).toBe(false);
    expect(tag.el.textContent).toContain('simple mode');
    expect(tag.el.textContent).toContain('built-in rules');
  });

  it('takes a supplied reason', () => {
    const tag = createModeTag();
    tag.update({ ruleMode: true, reason: 'The AI provider is unreachable, so the host is using built-in rules.' });
    expect(tag.el.textContent).toContain('unreachable');
    expect(tag.el.getAttribute('title')).toContain('unreachable');
  });

  it('is never an alert and never a live region', () => {
    const tag = createModeTag();
    tag.update({ ruleMode: true });
    expect(tag.el.getAttribute('role')).toBeNull();
    expect(tag.el.getAttribute('aria-live')).toBeNull();
  });

  it('goes quiet again when the AI comes back', () => {
    const tag = createModeTag();
    tag.update({ ruleMode: true });
    tag.update({ ruleMode: false });
    expect(tag.el.hidden).toBe(true);
  });
});

/* ------------------------------------------------------------------ copy - */

describe('copy', () => {
  it('uses no exclamation marks anywhere it renders (plan §5.4)', () => {
    const parts: string[] = [];

    const talk = createTalkButton({
      onPress: vi.fn(),
      onInterrupt: vi.fn(),
      element: document.createElement('button'),
    });
    for (const state of STATES) {
      talk.update({ state });
      parts.push(talk.el.textContent ?? '', accessibleName(talk.el));
    }

    const typed = createTypeInput({ onSubmit: vi.fn() });
    typed.update({ visible: true, disabled: false });
    parts.push(typed.el.textContent ?? '');

    const latency = createLatencyReadout();
    latency.update({ ms: 840, source: 'llm' });
    parts.push(latency.el.textContent ?? '', latency.el.getAttribute('title') ?? '');

    const tag = createModeTag();
    tag.update({ ruleMode: true });
    parts.push(tag.el.textContent ?? '', tag.el.getAttribute('title') ?? '');

    expect(parts.join(' ')).not.toContain('!');
  });
});
