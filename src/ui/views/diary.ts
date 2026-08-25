/**
 * The diary view and the transcript viewer (T-104, T-105).
 *
 * Most of this file exists for one paragraph of the plan. §10.3: *watching the
 * engine catch the AI is the most persuasive thing in the demo.* Every proposal
 * the engine refused is already recorded on the turn that produced it, so the
 * only thing left to do is refuse to hide it — no toggle, no "advanced" pane,
 * no red border that reads as a bug report. A refusal is the architecture
 * working, and it is presented as such: the machine reason the engine used, and
 * the plain-English detail beside it.
 *
 * The other decisions here are smaller but not arbitrary:
 *
 *   - **The conversation belonging to the new booking opens by itself.** The
 *     rejections are the point of the view; making the visitor hunt for them
 *     behind a disclosure would bury the thing worth seeing. Every other
 *     conversation stays collapsed, and a panel the visitor closes stays closed
 *     across updates.
 *   - **Clearing the demo data takes two steps.** One click that destroys the
 *     booking someone just spent a minute making is not a control, it is a
 *     trap. The confirmation is in the page rather than in `window.confirm`,
 *     which is unstyleable, blocking, and lies about which site is asking.
 */

import type { Booking } from '../../engine/index.js';
import { formatTime12 } from '../../engine/index.js';
import type { BookingRepository, Transcript, TranscriptTurn } from '../../agent/ports.js';
import { formatPhone } from '../../agent/brains/parse/phone.js';
import { clear, el } from '../a11y.js';
import type { Component } from '../components/component.js';
import { createDiaryTable } from '../components/diary-table.js';
import '../styles/components/diary.css';

export interface DiaryViewProps {
  readonly bookings: readonly Booking[];
  readonly transcripts: readonly Transcript[];
  readonly highlightId?: string;
  readonly today: string;
  /**
   * False when storage fell back to memory — private browsing, or storage
   * disabled. Plan §7.5 F10 asks for a small note rather than a booking that
   * silently disappears on refresh.
   */
  readonly persistent?: boolean;
}

export interface DiaryViewOptions {
  readonly repository: BookingRepository;
  readonly onBack: () => void;
}

/** One rejected proposal, as the engine recorded it on the turn. */
type Rejected = NonNullable<TranscriptTurn['rejected']>[number];

/**
 * Which brain authored an agent turn.
 *
 * Named in words rather than shown as `llm` / `rule`, because the claim being
 * made — the same engine checks both — is lost on anyone who has to guess what
 * the abbreviation stands for.
 */
const BRAIN_LABEL: Readonly<Record<'llm' | 'rule', string>> = {
  llm: 'language model',
  rule: 'rule brain',
};

const SPEAKER_LABEL: Readonly<Record<TranscriptTurn['role'], string>> = {
  agent: 'Hostline',
  visitor: 'You',
};

const CLEAR_WARNING = 'This removes every booking and conversation stored in this browser.';
const CLEARED = 'Cleared — nothing from this demo is left in the browser.';
const CLEAR_FAILED = 'The data could not be cleared — reload the page and try again.';

/* -------------------------------------------------------------- rendering -- */

/**
 * A refused proposal, attached to the turn that produced it.
 *
 * A description list rather than a sentence: there are two distinct facts here
 * — the reason code the engine uses internally, and what that code means — and
 * pairing them is exactly what `<dl>` is for. The reason stays in `<code>`
 * because it is a literal identifier a reader can grep the source for, which is
 * half of why showing it is convincing at all.
 */
function renderRejection(rejection: Rejected): HTMLElement {
  const box = el('div', {
    className: 'diary__rejection',
    attrs: { 'data-reason': rejection.reason, 'data-rejection': 'true' },
  });

  box.append(el('p', { className: 'diary__rejection-label', text: 'The engine refused this proposal' }));

  const pairs = el('dl', { className: 'diary__rejection-pairs' });
  pairs.append(
    el('dt', { text: 'Reason' }),
    el('dd', { children: [el('code', { className: 'diary__rejection-reason', text: rejection.reason })] }),
    el('dt', { text: 'What that means' }),
    el('dd', { className: 'diary__rejection-detail', text: rejection.detail }),
  );
  box.append(pairs);

  return box;
}

function renderTurn(turn: TranscriptTurn): HTMLElement {
  const item = el('li', { className: 'diary__turn', attrs: { 'data-role': turn.role } });

  const byline = el('p', { className: 'diary__byline' });
  byline.append(el('span', { className: 'diary__speaker', text: SPEAKER_LABEL[turn.role] }));
  if (turn.brain !== undefined) {
    byline.append(
      el('span', {
        className: 'diary__brain',
        text: BRAIN_LABEL[turn.brain],
        attrs: { 'data-brain': turn.brain },
      }),
    );
  }

  item.append(byline, el('p', { className: 'diary__said', text: turn.text }));
  for (const rejection of turn.rejected ?? []) item.append(renderRejection(rejection));

  return item;
}

/** The booking a conversation produced, for the head of the opened panel. */
function renderBookingSummary(booking: Booking): HTMLElement {
  const phone = formatPhone(booking.phone);
  const parts = [booking.name, `${booking.partySize} at ${formatTime12(booking.time)}`, phone, booking.reference];
  return el('p', {
    className: 'diary__summary',
    text: parts.filter((part) => part !== '').join(' · '),
  });
}

function labelFor(booking: Booking | undefined): string {
  if (booking === undefined) return 'Read the conversation';
  return `Read the conversation — ${booking.name}, ${formatTime12(booking.time)}`;
}

/* ------------------------------------------------------------------ view -- */

export function createDiaryView(options: DiaryViewOptions): Component<DiaryViewProps> {
  const root = el('section', { className: 'diary', attrs: { 'aria-labelledby': 'diary-title' } });

  const table = createDiaryTable();

  /** Transcript ids the visitor has open. Survives `update`. */
  const opened = new Set<string>();
  /** Transcript ids already offered automatically, so a close stays closed. */
  const autoOpened = new Set<string>();

  const conversations = el('div', { className: 'diary__conversations' });
  const status = el('p', {
    className: 'diary__status',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });

  /* ---- header ---------------------------------------------------------- */

  const back = el('button', {
    className: 'diary__back',
    text: 'Back to the conversation',
    attrs: { type: 'button' },
  });
  back.addEventListener('click', () => options.onBack());

  const header = el('header', {
    className: 'diary__header',
    children: [
      back,
      el('h2', { className: 'diary__title', text: 'The diary', attrs: { id: 'diary-title' } }),
      el('p', {
        className: 'diary__lede',
        text: 'What the restaurant sees, including every proposal the engine refused.',
      }),
    ],
  });

  /* ---- clearing -------------------------------------------------------- */

  const clearButton = el('button', {
    className: 'diary__clear',
    text: 'Clear demo data',
    attrs: { type: 'button', 'aria-expanded': 'false' },
  });

  const confirmButton = el('button', {
    className: 'diary__confirm-yes',
    text: 'Yes, clear it',
    attrs: { type: 'button' },
  });

  const keepButton = el('button', {
    className: 'diary__confirm-no',
    text: 'Keep it',
    attrs: { type: 'button' },
  });

  const confirmBox = el('div', {
    className: 'diary__confirm',
    children: [
      el('p', { className: 'diary__confirm-warning', text: CLEAR_WARNING }),
      el('div', { className: 'diary__confirm-actions', children: [confirmButton, keepButton] }),
    ],
  });
  confirmBox.hidden = true;

  const setConfirming = (confirming: boolean): void => {
    confirmBox.hidden = !confirming;
    clearButton.setAttribute('aria-expanded', String(confirming));
    clearButton.disabled = confirming;
  };

  clearButton.addEventListener('click', () => {
    status.textContent = '';
    setConfirming(true);
    // The destructive button gets focus, so a keyboard visitor lands on the
    // choice rather than tabbing back through the whole diary to find it.
    confirmButton.focus();
  });

  keepButton.addEventListener('click', () => {
    setConfirming(false);
    clearButton.focus();
  });

  confirmButton.addEventListener('click', () => {
    setConfirming(false);
    void options.repository.clear().then(
      () => {
        status.textContent = CLEARED;
      },
      () => {
        // Says what happened and what to do, in that order (plan §5.4).
        status.textContent = CLEAR_FAILED;
      },
    );
  });

  const controls = el('div', {
    className: 'diary__controls',
    children: [clearButton, confirmBox, status],
  });

  root.append(header, table.el, conversations, controls);

  /* ---- conversations --------------------------------------------------- */

  function renderConversation(transcript: Transcript, booking: Booking | undefined): HTMLElement {
    const panelId = `diary-turns-${transcript.id}`;
    const isOpen = opened.has(transcript.id);

    const toggle = el('button', {
      className: 'diary__read',
      text: labelFor(booking),
      attrs: {
        type: 'button',
        'aria-expanded': String(isOpen),
        'aria-controls': panelId,
        'data-transcript-id': transcript.id,
      },
    });

    const turns = el('ol', { className: 'diary__turns' });
    for (const turn of transcript.turns) turns.append(renderTurn(turn));

    const panel = el('div', { className: 'diary__panel', attrs: { id: panelId } });
    if (booking !== undefined) panel.append(renderBookingSummary(booking));
    panel.append(turns);
    panel.hidden = !isOpen;

    toggle.addEventListener('click', () => {
      const nowOpen = panel.hidden;
      panel.hidden = !nowOpen;
      toggle.setAttribute('aria-expanded', String(nowOpen));
      if (nowOpen) opened.add(transcript.id);
      else opened.delete(transcript.id);
    });

    return el('div', { className: 'diary__conversation', children: [toggle, panel] });
  }

  const storageNote = el('p', {
    className: 'diary__note small',
    text: 'This browser will not keep these bookings after you close the tab.',
  });
  storageNote.hidden = true;
  root.append(storageNote);

  return {
    el: root,

    update(props: DiaryViewProps): void {
      // F10. Quiet, one line, and only when it is true — a visitor whose
      // bookings *will* persist should never see a note about storage.
      storageNote.hidden = props.persistent !== false;

      table.update({
        bookings: props.bookings,
        today: props.today,
        // `exactOptionalPropertyTypes`: an absent highlight is an absent key,
        // not a key holding `undefined`.
        ...(props.highlightId === undefined ? {} : { highlightId: props.highlightId }),
      });

      const bookingsById = new Map(props.bookings.map((booking) => [booking.id, booking]));

      for (const transcript of props.transcripts) {
        const belongsToNew = props.highlightId !== undefined && transcript.bookingId === props.highlightId;
        if (belongsToNew && !autoOpened.has(transcript.id)) {
          autoOpened.add(transcript.id);
          opened.add(transcript.id);
        }
      }

      clear(conversations);
      if (props.transcripts.length > 0) {
        conversations.append(el('h3', { className: 'diary__subtitle', text: 'Conversations' }));
        for (const transcript of props.transcripts) {
          const booking = transcript.bookingId === undefined ? undefined : bookingsById.get(transcript.bookingId);
          conversations.append(renderConversation(transcript, booking));
        }
      }
    },

    destroy(): void {
      table.destroy?.();
      clear(root);
    },
  };
}
