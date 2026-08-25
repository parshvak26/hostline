/**
 * The demo restaurant's existing diary (T-034).
 *
 * ## Why this file exists
 *
 * A reviewer given a booking demo asks for the most obvious thing: a table for
 * four, on Friday, at seven. If that always succeeds, they never see the part
 * of the system worth seeing — the engine refusing, and offering three real
 * alternatives it computed from actual table inventory. So **19:00 on the next
 * Friday is deliberately full**, and it is full for the party size people
 * actually ask for. Plan §10.6 calls this "a designed demo moment, not an
 * accident", and this is where the design lives.
 *
 * ## Why there are seven blocking bookings and not four
 *
 * Plan §10.6 suggests 4–6 seeded bookings. That is not enough to make the slot
 * genuinely full, and the reason is best-fit allocation. A party of four fits a
 * four-top *or* a six-top, so filling only the five four-tops leaves both
 * six-tops free and the request succeeds. Blocking it honestly needs all five
 * `T4`s and both `T6`s occupied across the requested interval — seven tables,
 * seven bookings. Faking it any other way would mean special-casing the engine,
 * which is the one thing this project must not do.
 *
 * The two-tops are left free, so a party of two still gets 19:00. That is
 * correct rather than convenient: the room really does have space, just not for
 * four people. See `docs/decisions/0004-seeded-diary-size.md`.
 *
 * ## Why the times are what they are
 *
 * Friday dinner opens at 18:30 and a party of four holds a table for 105
 * minutes, so a booking at 18:30 runs to 20:15. Seeding the blocking bookings
 * at 18:30–19:00 makes 19:00 unbookable while leaving 20:15, 20:30 and 20:45
 * free — which is exactly three alternatives inside the engine's ±120-minute
 * search. Move these times and that number changes; the test in
 * `tests/unit/seed.test.ts` is what will tell you.
 */

import type { Booking, DiaryEntry, EngineDeps, IsoDate, RestaurantConfig } from '../engine/index.js';
import { addDays, turnTimeFor, weekdayOf } from '../engine/index.js';

/** Synthetic throughout. No real person appears anywhere in this repository. */
interface SeedRow {
  readonly time: string;
  readonly partySize: number;
  readonly tableId: string;
  readonly name: string;
  readonly phone: string;
}

/** The seven that make 19:00 unbookable for a party of four. */
const FRIDAY_BLOCKING: readonly SeedRow[] = [
  { time: '18:30', partySize: 4, tableId: 'T4', name: 'Menon', phone: '9820055101' },
  { time: '18:30', partySize: 3, tableId: 'T4', name: 'Fernandes', phone: '9820055102' },
  { time: '18:45', partySize: 4, tableId: 'T4', name: 'Bhatia', phone: '9820055103' },
  { time: '18:45', partySize: 4, tableId: 'T4', name: 'Rao', phone: '9820055104' },
  { time: '19:00', partySize: 4, tableId: 'T4', name: 'Sequeira', phone: '9820055105' },
  { time: '18:30', partySize: 6, tableId: 'T6', name: 'Iyer', phone: '9820055106' },
  { time: '19:00', partySize: 5, tableId: 'T6', name: 'Chowdhury', phone: '9820055107' },
];

/** Two-tops, so the diary reads like a real service rather than a fixture. */
const FRIDAY_COLOUR: readonly SeedRow[] = [
  { time: '18:30', partySize: 2, tableId: 'T2', name: 'Patel', phone: '9820055108' },
  { time: '20:00', partySize: 2, tableId: 'T2', name: 'D’Souza', phone: '9820055109' },
];

/** The service day before Friday, so "tonight" is never an empty screen. */
const THURSDAY: readonly SeedRow[] = [
  { time: '19:00', partySize: 2, tableId: 'T2', name: 'Kulkarni', phone: '9820055110' },
  { time: '19:30', partySize: 4, tableId: 'T4', name: 'Shaikh', phone: '9820055111' },
  { time: '20:15', partySize: 6, tableId: 'T6', name: 'Mistry', phone: '9820055112' },
];

/** The Friday the demo is arranged around: the next one strictly after today. */
export function nextFriday(today: IsoDate): IsoDate {
  for (let ahead = 1; ahead <= 7; ahead += 1) {
    const candidate = addDays(today, ahead);
    if (weekdayOf(candidate) === 'fri') return candidate;
  }
  return addDays(today, 7);
}

/** The most recent Thursday on or after today, used only for diary colour. */
function seedThursday(today: IsoDate): IsoDate {
  const friday = nextFriday(today);
  return addDays(friday, -1);
}

function toBooking(
  row: SeedRow,
  date: IsoDate,
  config: RestaurantConfig,
  index: number,
  createdAt: string,
): Booking {
  return {
    id: `seed-${date}-${index}`,
    // Seeded references share a prefix so they are obviously demo data both on
    // screen and in a bug report.
    reference: `EO${String(index).padStart(3, '0')}`,
    date,
    time: row.time,
    partySize: row.partySize,
    name: row.name,
    phone: row.phone,
    tableId: row.tableId,
    durationMinutes: turnTimeFor(row.partySize, config),
    createdAt,
    source: 'typed',
    brain: 'rule',
    outcome: 'booked',
    seeded: true,
  };
}

/**
 * Build the diary as it should look on first load.
 *
 * Relative to the injected clock, never to a hard-coded date — the demo has to
 * still work in two years without anyone touching it (goal §18.12), and a
 * seeded diary pinned to August 2026 would quietly become a list of bookings in
 * the past.
 */
export function buildSeedDiary(config: RestaurantConfig, today: IsoDate, createdAt: string): Booking[] {
  const friday = nextFriday(today);
  const thursday = seedThursday(today);

  const rows: Array<{ row: SeedRow; date: IsoDate }> = [
    ...FRIDAY_BLOCKING.map((row) => ({ row, date: friday })),
    ...FRIDAY_COLOUR.map((row) => ({ row, date: friday })),
    ...THURSDAY.map((row) => ({ row, date: thursday })),
  ];

  return rows.map(({ row, date }, index) => toBooking(row, date, config, index + 1, createdAt));
}

/** The slice the availability engine needs. */
export function toDiaryEntries(bookings: readonly Booking[]): DiaryEntry[] {
  return bookings.map((b) => ({
    date: b.date,
    time: b.time,
    tableId: b.tableId,
    durationMinutes: b.durationMinutes,
  }));
}

/** Convenience for scripts and tests that want deps with the seeded diary in. */
export function seededDeps(base: Omit<EngineDeps, 'diary'>): EngineDeps {
  const today = base.clock.now().date;
  const bookings = buildSeedDiary(base.config, today, base.clock.now().iso);
  return { ...base, diary: toDiaryEntries(bookings) };
}
