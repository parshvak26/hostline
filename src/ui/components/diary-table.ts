/**
 * The restaurant's diary (T-104).
 *
 * This is the component that makes the demo real. A confirmation card is a
 * promise; the diary is the evidence — the visitor's booking sitting in a list
 * beside four bookings that were already there (R-52). So the markup is a real
 * `<table>`: rows of times and names *are* tabular data, and a grid of `<div>`s
 * would take that away from anyone navigating by cell.
 *
 * The one rule that shapes everything else: **the new row is marked with a rule
 * and a word, never a background colour** (plan §5.3, §14). Printed in
 * greyscale, photographed by someone with deuteranopia, or rendered in forced
 * colours, the visitor still finds their booking — because "new" is a word in a
 * cell, not a tint behind one.
 */

import type { Booking, IsoDate } from '../../engine/index.js';
import { formatDateLong, formatTime12 } from '../../engine/index.js';
import { clear, el } from '../a11y.js';
import type { Component } from './component.js';

export interface DiaryTableProps {
  readonly bookings: readonly Booking[];
  /** The booking just made, if any. Marked "new" rather than tinted. */
  readonly highlightId?: string;
  /** Today's date, so the current service day can be called "Tonight". */
  readonly today: string;
}

/** Plan §4.4. A diary with none of the visitor's own bookings is not blank. */
const NOTHING_YET = "Nothing of yours yet — talk to us and it'll appear here.";

const COLUMNS: readonly string[] = ['Time', 'Name', 'Guests', 'Party'];

/**
 * The marker each row carries in its final column.
 *
 * Three states, three words. `seeded` bookings shipped with the demo; anything
 * else was made by the person reading the screen, and exactly one of those can
 * be the booking they just finished.
 */
type MarkerKind = 'new' | 'yours' | 'demo';

const MARKER_LABEL: Readonly<Record<MarkerKind, string>> = {
  new: 'new',
  yours: 'yours',
  demo: 'demo',
};

function markerFor(booking: Booking, highlightId: string | undefined): MarkerKind {
  if (highlightId !== undefined && booking.id === highlightId) return 'new';
  return booking.seeded ? 'demo' : 'yours';
}

/** Date first, then time. Both are zero-padded, so string order is time order. */
function byDateThenTime(a: Booking, b: Booking): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * One group per service day, in date order.
 *
 * The seeded diary deliberately spans two days (plan §10.6), so a single
 * undivided list would put Friday's 21:00 next to Saturday's 18:30 with nothing
 * to say they are different evenings.
 */
function groupByDate(bookings: readonly Booking[]): ReadonlyArray<readonly [IsoDate, readonly Booking[]]> {
  const groups = new Map<IsoDate, Booking[]>();
  for (const booking of [...bookings].sort(byDateThenTime)) {
    const existing = groups.get(booking.date);
    if (existing === undefined) groups.set(booking.date, [booking]);
    else existing.push(booking);
  }
  return [...groups.entries()];
}

function guestsText(partySize: number): string {
  return `${partySize} ${partySize === 1 ? 'guest' : 'guests'}`;
}

function captionFor(date: IsoDate, today: string): string {
  const long = formatDateLong(date);
  return date === today ? `Tonight · ${long}` : long;
}

function renderRow(booking: Booking, highlightId: string | undefined): HTMLTableRowElement {
  const kind = markerFor(booking, highlightId);

  const row = el('tr', {
    className: 'diary-table__row',
    attrs: { 'data-booking-id': booking.id, 'data-marker': kind, 'data-seeded': String(booking.seeded) },
  });
  // Read by the e2e test, and by the CSS that draws the hairline. The attribute
  // is absent rather than "false" on ordinary rows so `[data-new]` is enough.
  if (kind === 'new') row.setAttribute('data-new', 'true');

  const marker = el('span', {
    className: `diary-table__marker diary-table__marker--${kind}`,
    text: MARKER_LABEL[kind],
  });

  row.append(
    // The time identifies the row the way a name identifies a person here, so
    // it is the row header rather than an ordinary cell.
    el('th', { className: 'diary-table__time', text: formatTime12(booking.time), attrs: { scope: 'row' } }),
    el('td', { className: 'diary-table__name', text: booking.name }),
    el('td', { className: 'diary-table__guests', text: guestsText(booking.partySize) }),
    el('td', { className: 'diary-table__party', children: [marker] }),
  );

  return row;
}

function renderDay(date: IsoDate, bookings: readonly Booking[], props: DiaryTableProps): HTMLTableElement {
  const table = el('table', { className: 'diary-table__day', attrs: { 'data-date': date } });

  table.append(el('caption', { className: 'diary-table__caption', text: captionFor(date, props.today) }));

  const headRow = el('tr');
  for (const column of COLUMNS) {
    headRow.append(el('th', { className: 'diary-table__head', text: column, attrs: { scope: 'col' } }));
  }
  table.append(el('thead', { children: [headRow] }));

  const body = el('tbody');
  for (const booking of bookings) body.append(renderRow(booking, props.highlightId));
  table.append(body);

  return table;
}

export function createDiaryTable(): Component<DiaryTableProps> {
  const root = el('div', { className: 'diary-table' });

  return {
    el: root,

    update(props: DiaryTableProps): void {
      clear(root);

      const groups = groupByDate(props.bookings);
      if (groups.length > 0) {
        // The table scrolls inside this container at narrow widths; the page
        // body never scrolls sideways. A scrollable region has to be reachable
        // by keyboard (WCAG 2.1.1), hence the tabindex and the name.
        const scroller = el('div', {
          className: 'diary-table__scroll',
          attrs: { role: 'region', 'aria-label': 'The diary', tabindex: '0' },
        });
        for (const [date, bookings] of groups) scroller.append(renderDay(date, bookings, props));
        root.append(scroller);
      }

      // Plan §4.4: the seeded diary stays, and the visitor is told where their
      // own booking will appear. Never an empty container.
      if (!props.bookings.some((booking) => !booking.seeded)) {
        root.append(el('p', { className: 'diary-table__empty', text: NOTHING_YET }));
      }
    },
  };
}
