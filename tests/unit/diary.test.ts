// @vitest-environment jsdom

/**
 * The diary and the transcript viewer (T-104, T-105).
 *
 * The acceptance criteria for these two tasks are both things a screenshot
 * could fake, so they are asserted here instead:
 *
 *   - the new booking is identifiable **without colour**, which means a word in
 *     the DOM rather than a class that happens to paint something;
 *   - a conversation containing a refused proposal **displays it**, reason and
 *     detail both, not behind a toggle.
 *
 * The repository is a hand-written stub rather than a mocking library. There
 * are seven methods and this file uses one of them; a framework would add a
 * dependency to save four lines.
 */

import { describe, expect, it } from 'vitest';
import type { Booking } from '../../src/engine/index.js';
import type { BookingRepository, Transcript, TranscriptTurn } from '../../src/agent/ports.js';
import { createDiaryTable } from '../../src/ui/components/diary-table.js';
import { createDiaryView } from '../../src/ui/views/diary.js';

const FRIDAY = '2026-08-28';
const SATURDAY = '2026-08-29';

function booking(overrides: Partial<Booking> & Pick<Booking, 'id'>): Booking {
  return {
    reference: `EO-${overrides.id.toUpperCase()}`,
    date: FRIDAY,
    time: '19:00',
    partySize: 2,
    name: 'Patel',
    phone: '9820011234',
    tableId: 'T2',
    durationMinutes: 90,
    createdAt: '2026-08-25T10:00:00.000Z',
    source: 'voice',
    brain: 'llm',
    outcome: 'booked',
    seeded: true,
    ...overrides,
  };
}

function transcript(overrides: Partial<Transcript> & Pick<Transcript, 'id'>): Transcript {
  return {
    startedAt: '2026-08-25T10:00:00.000Z',
    locale: 'en-IN',
    turns: [],
    latencies: [],
    ...overrides,
  };
}

function turn(overrides: Partial<TranscriptTurn> & Pick<TranscriptTurn, 'role' | 'text'>): TranscriptTurn {
  return { at: '2026-08-25T10:00:01.000Z', ...overrides };
}

interface Stub {
  readonly repository: BookingRepository;
  clears(): number;
}

function makeRepository(behaviour: 'ok' | 'fails' = 'ok'): Stub {
  let clears = 0;
  const repository: BookingRepository = {
    kind: 'memory',
    persistent: false,
    init: () => Promise.resolve(),
    listBookings: () => Promise.resolve([]),
    saveBooking: () => Promise.resolve(),
    saveTranscript: () => Promise.resolve(),
    listTranscripts: () => Promise.resolve([]),
    clear: () => {
      clears += 1;
      return behaviour === 'ok' ? Promise.resolve() : Promise.reject(new Error('quota'));
    },
  };
  return { repository, clears: () => clears };
}

/** Mounted, because focus moves and `hidden` is read. */
function mount(element: HTMLElement): void {
  document.body.replaceChildren(element);
}

function text(node: Element | null): string {
  return (node?.textContent ?? '').trim();
}

/* ------------------------------------------------------------ the table -- */

describe('the diary table', () => {
  it('renders bookings sorted by time, not by the order they arrived', () => {
    const table = createDiaryTable();
    table.update({
      today: FRIDAY,
      bookings: [
        booking({ id: 'c', time: '21:00', name: 'Rao' }),
        booking({ id: 'a', time: '18:30', name: 'Mehta' }),
        booking({ id: 'b', time: '19:45', name: 'Iyer' }),
      ],
    });

    const times = [...table.el.querySelectorAll('.diary-table__time')].map((cell) => text(cell));
    expect(times).toEqual(['6:30 pm', '7:45 pm', '9:00 pm']);
  });

  it('groups by service day, one table and one caption per date, in date order', () => {
    const table = createDiaryTable();
    table.update({
      today: FRIDAY,
      bookings: [
        booking({ id: 'b', date: SATURDAY, time: '18:30' }),
        booking({ id: 'a', date: FRIDAY, time: '20:00' }),
      ],
    });

    const days = [...table.el.querySelectorAll('.diary-table__day')];
    expect(days).toHaveLength(2);
    expect(days.map((day) => day.getAttribute('data-date'))).toEqual([FRIDAY, SATURDAY]);
    expect(text(days[1]?.querySelector('caption') ?? null)).toBe('Saturday 29 August');
  });

  it("names the current service day rather than only dating it", () => {
    const table = createDiaryTable();
    table.update({ today: FRIDAY, bookings: [booking({ id: 'a' })] });

    expect(text(table.el.querySelector('caption'))).toBe('Tonight · Friday 28 August');
  });

  it('pluralises the guest count', () => {
    const table = createDiaryTable();
    table.update({
      today: FRIDAY,
      bookings: [
        booking({ id: 'a', time: '18:00', partySize: 1 }),
        booking({ id: 'b', time: '19:00', partySize: 4 }),
      ],
    });

    const guests = [...table.el.querySelectorAll('.diary-table__guests')].map((cell) => text(cell));
    expect(guests).toEqual(['1 guest', '4 guests']);
  });

  it('is a real table: caption, column headers with a scope, and a row header', () => {
    const table = createDiaryTable();
    table.update({ today: FRIDAY, bookings: [booking({ id: 'a' })] });

    const day = table.el.querySelector('table');
    expect(day).not.toBeNull();
    expect(day?.querySelector('caption')).not.toBeNull();

    const heads = [...table.el.querySelectorAll('th[scope="col"]')];
    expect(heads.map((head) => text(head))).toEqual(['Time', 'Name', 'Guests', 'Party']);
    expect(table.el.querySelector('th[scope="row"]')).not.toBeNull();
  });

  it('marks the new booking with data-new and a word, never colour alone', () => {
    const table = createDiaryTable();
    table.update({
      today: FRIDAY,
      highlightId: 'mine',
      bookings: [booking({ id: 'other', time: '18:30' }), booking({ id: 'mine', time: '19:00', seeded: false })],
    });

    const marked = [...table.el.querySelectorAll('[data-new="true"]')];
    expect(marked).toHaveLength(1);
    expect(marked[0]?.getAttribute('data-booking-id')).toBe('mine');

    // The acceptance criterion: strip every stylesheet and the row still says
    // what it is, because "new" is text.
    expect(text(marked[0]?.querySelector('.diary-table__marker') ?? null)).toBe('new');
    expect(text(marked[0] ?? null)).toContain('new');
  });

  it('distinguishes seeded demo rows from the visitor’s own, in text', () => {
    const table = createDiaryTable();
    table.update({
      today: FRIDAY,
      bookings: [
        booking({ id: 'seed', time: '18:30', seeded: true }),
        booking({ id: 'ours', time: '19:30', seeded: false }),
      ],
    });

    const rows = [...table.el.querySelectorAll('.diary-table__row')];
    expect(rows.map((row) => row.getAttribute('data-seeded'))).toEqual(['true', 'false']);
    expect(rows.map((row) => text(row.querySelector('.diary-table__marker')))).toEqual(['demo', 'yours']);
  });

  it('shows the seeded diary plus the standing line when nothing is the visitor’s', () => {
    const table = createDiaryTable();
    table.update({
      today: FRIDAY,
      bookings: [booking({ id: 'a', time: '18:30' }), booking({ id: 'b', time: '20:00' })],
    });

    expect(table.el.querySelectorAll('.diary-table__row')).toHaveLength(2);
    expect(text(table.el.querySelector('.diary-table__empty'))).toBe(
      "Nothing of yours yet — talk to us and it'll appear here.",
    );
  });

  it('is never an empty container, even with no bookings at all', () => {
    const table = createDiaryTable();
    table.update({ today: FRIDAY, bookings: [] });

    expect(table.el.children.length).toBeGreaterThan(0);
    expect(text(table.el)).toContain('Nothing of yours yet');
  });

  it('drops the standing line once the visitor has a booking of their own', () => {
    const table = createDiaryTable();
    table.update({ today: FRIDAY, bookings: [booking({ id: 'a', seeded: false })] });

    expect(table.el.querySelector('.diary-table__empty')).toBeNull();
  });

  it('confines any overflow to its own scroll container', () => {
    const table = createDiaryTable();
    table.update({ today: FRIDAY, bookings: [booking({ id: 'a' })] });

    const scroller = table.el.querySelector('.diary-table__scroll');
    expect(scroller).not.toBeNull();
    // A scrollable region has to be reachable without a mouse (WCAG 2.1.1).
    expect(scroller?.getAttribute('tabindex')).toBe('0');
    expect(scroller?.getAttribute('role')).toBe('region');
  });

  it('renders a name containing markup as text and creates no element from it', () => {
    const table = createDiaryTable();
    const hostile = '<script>alert("x")</script>';
    table.update({ today: FRIDAY, bookings: [booking({ id: 'a', name: hostile })] });
    mount(table.el);

    expect(table.el.querySelector('script')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(text(table.el.querySelector('.diary-table__name'))).toBe(hostile);
  });
});

/* ------------------------------------------------------------- the view -- */

const REJECTION = {
  reason: 'party_too_large',
  detail: 'The largest table seats six, and ten was proposed.',
} as const;

function viewWithConversation(): {
  view: ReturnType<typeof createDiaryView>;
  stub: Stub;
  backs: () => number;
} {
  const stub = makeRepository();
  let backs = 0;
  const view = createDiaryView({ repository: stub.repository, onBack: () => (backs += 1) });

  const mine = booking({ id: 'mine', time: '19:00', name: 'Priya', seeded: false });
  view.update({
    today: FRIDAY,
    highlightId: 'mine',
    bookings: [booking({ id: 'seed', time: '18:30' }), mine],
    transcripts: [
      transcript({
        id: 't1',
        bookingId: 'mine',
        turns: [
          turn({ role: 'agent', text: 'Ember and Oak, how can I help?', brain: 'rule' }),
          turn({ role: 'visitor', text: 'A table for ten on Friday.' }),
          turn({
            role: 'agent',
            text: 'Six is the most we can seat at one table.',
            brain: 'llm',
            rejected: [REJECTION],
          }),
        ],
      }),
    ],
  });

  mount(view.el);
  return { view, stub, backs: () => backs };
}

describe('the transcript viewer', () => {
  it('offers a control to read each conversation, named by its booking', () => {
    const { view } = viewWithConversation();

    const toggle = view.el.querySelector('.diary__read');
    expect(text(toggle)).toBe('Read the conversation — Priya, 7:00 pm');
  });

  it('lists every turn in order, with who said it', () => {
    const { view } = viewWithConversation();

    const turns = [...view.el.querySelectorAll('.diary__turn')];
    expect(turns.map((item) => item.getAttribute('data-role'))).toEqual(['agent', 'visitor', 'agent']);
    expect(turns.map((item) => text(item.querySelector('.diary__speaker')))).toEqual(['Hostline', 'You', 'Hostline']);
    expect(text(turns[1]?.querySelector('.diary__said') ?? null)).toBe('A table for ten on Friday.');
  });

  it('says which brain handled each agent turn, in words', () => {
    const { view } = viewWithConversation();

    const brains = [...view.el.querySelectorAll('.diary__brain')];
    expect(brains.map((tag) => tag.getAttribute('data-brain'))).toEqual(['rule', 'llm']);
    expect(brains.map((tag) => text(tag))).toEqual(['rule brain', 'language model']);
    // The visitor's turn has no brain, and does not get a blank tag.
    expect(view.el.querySelectorAll('.diary__turn[data-role="visitor"] .diary__brain')).toHaveLength(0);
  });

  it('displays a refused proposal with both its reason and its detail (T-105)', () => {
    const { view } = viewWithConversation();

    const rejections = [...view.el.querySelectorAll('.diary__rejection')];
    expect(rejections).toHaveLength(1);

    const shown = rejections[0];
    expect(shown?.getAttribute('data-reason')).toBe('party_too_large');
    expect(text(shown?.querySelector('.diary__rejection-reason') ?? null)).toBe('party_too_large');
    expect(text(shown?.querySelector('.diary__rejection-detail') ?? null)).toBe(REJECTION.detail);
    expect(text(shown ?? null)).toContain('The engine refused this proposal');
  });

  it('attaches the refusal to the turn that produced it, not to the conversation', () => {
    const { view } = viewWithConversation();

    const owner = view.el.querySelector('.diary__rejection')?.closest('.diary__turn');
    expect(owner?.getAttribute('data-role')).toBe('agent');
    expect(text(owner?.querySelector('.diary__said') ?? null)).toBe('Six is the most we can seat at one table.');
  });

  it('does not hide the refusal behind a second disclosure, and opens the new booking’s conversation', () => {
    const { view } = viewWithConversation();

    const shown = view.el.querySelector('.diary__rejection');
    expect(shown?.closest('details')).toBeNull();
    expect(shown?.closest('[hidden]')).toBeNull();
    expect(view.el.querySelector('.diary__read')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('renders every refusal on a turn that carries more than one', () => {
    const stub = makeRepository();
    const view = createDiaryView({ repository: stub.repository, onBack: () => undefined });

    view.update({
      today: FRIDAY,
      highlightId: 'mine',
      bookings: [booking({ id: 'mine', seeded: false })],
      transcripts: [
        transcript({
          id: 't1',
          bookingId: 'mine',
          turns: [
            turn({
              role: 'agent',
              text: 'Let me check that.',
              brain: 'llm',
              rejected: [REJECTION, { reason: 'date_in_past', detail: 'The date proposed has already gone.' }],
            }),
          ],
        }),
      ],
    });

    const reasons = [...view.el.querySelectorAll('.diary__rejection-reason')].map((code) => text(code));
    expect(reasons).toEqual(['party_too_large', 'date_in_past']);
    expect([...view.el.querySelectorAll('.diary__rejection-detail')].map((d) => text(d))).toEqual([
      REJECTION.detail,
      'The date proposed has already gone.',
    ]);
  });

  it('collapses a conversation that is not the new booking’s, and opens it on request', () => {
    const stub = makeRepository();
    const view = createDiaryView({ repository: stub.repository, onBack: () => undefined });
    view.update({
      today: FRIDAY,
      bookings: [booking({ id: 'old', seeded: false })],
      transcripts: [
        transcript({ id: 't0', bookingId: 'old', turns: [turn({ role: 'visitor', text: 'Hello.' })] }),
      ],
    });
    mount(view.el);

    const toggle = view.el.querySelector('.diary__read');
    const panel = view.el.querySelector('.diary__panel');
    expect(panel).toBeInstanceOf(HTMLElement);
    expect((panel as HTMLElement).hidden).toBe(true);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    (toggle as HTMLElement).click();
    expect((panel as HTMLElement).hidden).toBe(false);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows nothing about conversations when there are none', () => {
    const stub = makeRepository();
    const view = createDiaryView({ repository: stub.repository, onBack: () => undefined });
    view.update({ today: FRIDAY, bookings: [booking({ id: 'a' })], transcripts: [] });

    expect(view.el.querySelectorAll('.diary__read')).toHaveLength(0);
    expect(text(view.el)).not.toContain('Read the conversation');
  });
});

describe('the diary view controls', () => {
  it('clears the demo data only on the second step', async () => {
    const { view, stub } = viewWithConversation();

    const clearButton = view.el.querySelector('.diary__clear');
    (clearButton as HTMLElement).click();
    expect(stub.clears()).toBe(0);

    const confirmButton = view.el.querySelector('.diary__confirm-yes');
    expect((view.el.querySelector('.diary__confirm') as HTMLElement).hidden).toBe(false);

    (confirmButton as HTMLElement).click();
    expect(stub.clears()).toBe(1);

    await Promise.resolve();
    expect(text(view.el.querySelector('.diary__status'))).toContain('Cleared');
  });

  it('lets the visitor back out of clearing without losing anything', () => {
    const { view, stub } = viewWithConversation();

    (view.el.querySelector('.diary__clear') as HTMLElement).click();
    (view.el.querySelector('.diary__confirm-no') as HTMLElement).click();

    expect(stub.clears()).toBe(0);
    expect((view.el.querySelector('.diary__confirm') as HTMLElement).hidden).toBe(true);
  });

  it('says what happened and what to do when clearing fails', async () => {
    const stub = makeRepository('fails');
    const view = createDiaryView({ repository: stub.repository, onBack: () => undefined });
    view.update({ today: FRIDAY, bookings: [], transcripts: [] });
    mount(view.el);

    (view.el.querySelector('.diary__clear') as HTMLElement).click();
    (view.el.querySelector('.diary__confirm-yes') as HTMLElement).click();

    await Promise.resolve();
    await Promise.resolve();
    expect(text(view.el.querySelector('.diary__status'))).toBe(
      'The data could not be cleared — reload the page and try again.',
    );
  });

  it('calls onBack from the back control', () => {
    const { view, backs } = viewWithConversation();

    (view.el.querySelector('.diary__back') as HTMLElement).click();
    expect(backs()).toBe(1);
  });

  it('renders the table inside the view, marked and grouped as the table promises', () => {
    const { view } = viewWithConversation();

    expect(view.el.querySelectorAll('[data-new="true"]')).toHaveLength(1);
    expect(text(view.el.querySelector('caption'))).toBe('Tonight · Friday 28 August');
  });
});
