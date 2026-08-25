/**
 * The booking engine's vocabulary.
 *
 * Everything in `src/engine/` is pure: no DOM, no network, no storage, and no
 * ambient clock. That is enforced by an ESLint rule, not by convention, and it
 * is the reason this directory can be tested exhaustively (plan §7.2, R-43).
 *
 * Two consequences show up all over this file:
 *
 *   - Time is a pair of strings, not a `Date`. Civil dates (`YYYY-MM-DD`) and
 *     civil times (`HH:MM`) in the restaurant's own timezone. Converting a real
 *     instant into those strings is the adapter's job, done once, outside here.
 *   - Anything non-deterministic — the clock, identifiers — arrives through
 *     {@link EngineDeps}.
 */

/* ------------------------------------------------------------------ time -- */

/** A civil date in the restaurant's timezone. `YYYY-MM-DD`. */
export type IsoDate = string;

/** A civil 24-hour time in the restaurant's timezone. `HH:MM`. */
export type ClockTime = string;

/** "Now", already resolved into the restaurant's local civil calendar. */
export interface Instant {
  readonly date: IsoDate;
  readonly time: ClockTime;
  /** Full ISO-8601 timestamp, used only for `Booking.createdAt`. */
  readonly iso: string;
}

export interface Clock {
  now(): Instant;
}

/** Injected so that references and ids are deterministic under test. */
export interface IdSource {
  newId(): string;
  newReference(): string;
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/* ----------------------------------------------------------- restaurant -- */

export interface OpeningDay {
  readonly day: Weekday;
  readonly closed?: boolean;
  /** Ordered, non-overlapping `[open, close]` pairs of `HH:MM`. */
  readonly windows?: ReadonlyArray<readonly [ClockTime, ClockTime]>;
}

export interface Closure {
  readonly date: IsoDate;
  readonly reason: string;
}

export interface TableClass {
  readonly id: string;
  readonly seats: number;
  /** How many physical tables of this class the room has. */
  readonly count: number;
}

export interface ServicePolicy {
  readonly slotMinutes: number;
  readonly leadTimeMinutes: number;
  readonly horizonDays: number;
  readonly maxPartySize: number;
  readonly minPartySize: number;
}

export interface SeatingPolicy {
  readonly combineTables: boolean;
  readonly lastSeatingBeforeCloseMinutes: number;
}

export interface RestaurantConfig {
  readonly id: string;
  readonly name: string;
  readonly established: number;
  readonly neighbourhood: string;
  readonly timezone: string;
  readonly locales: readonly string[];
  readonly service: ServicePolicy;
  readonly hours: readonly OpeningDay[];
  readonly closures: readonly Closure[];
  readonly tables: readonly TableClass[];
  /** Keyed by party size as a string, covering `1..maxPartySize`. */
  readonly turnTimeMinutes: Readonly<Record<string, number>>;
  readonly policy: SeatingPolicy;
}

/* ---------------------------------------------------------------- slots -- */

export type SlotName = 'date' | 'time' | 'partySize' | 'name' | 'phone';

export const SLOT_ORDER: readonly SlotName[] = ['date', 'time', 'partySize', 'name', 'phone'];

/**
 * `empty` → nothing heard yet.
 * `proposed` → a brain suggested a value; not yet checked.
 * `validated` → the engine independently accepted it.
 * `confirmed` → the visitor agreed to the read-back containing it.
 *
 * Only the engine ever writes `validated` or `confirmed`. A brain can move a
 * slot to `proposed` and no further; that is the boundary, in one type.
 */
export type SlotState = 'empty' | 'proposed' | 'validated' | 'confirmed';

export interface Slots {
  readonly date?: IsoDate;
  readonly time?: ClockTime;
  readonly partySize?: number;
  readonly name?: string;
  /** Normalised digits only. Formatted for display and read-back separately. */
  readonly phone?: string;
}

export type SlotStates = Readonly<Record<SlotName, SlotState>>;

/* ---------------------------------------------------------------- phase -- */

export type Phase =
  | 'greeting'
  | 'collecting'
  | 'checking'
  | 'offering_alternatives'
  | 'confirming'
  | 'committed'
  | 'ended';

export type Outcome = 'booked' | 'no_availability' | 'abandoned' | 'escalate';

/* ----------------------------------------------------------- rejections -- */

/**
 * Every way the engine can say no, as a closed union.
 *
 * A string reason would have been less work and would have let a future change
 * quietly stop rejecting something. These are asserted by name in
 * `tests/unit/adversarial.test.ts`, which is the evidence behind the project's
 * central claim (plan §16.2).
 */
export type RejectionReason =
  // Shape of the call itself
  | 'unknown_tool'
  | 'malformed_arguments'
  | 'unknown_field'
  | 'conflicting_proposal'
  // Date
  | 'date_unparseable'
  | 'date_in_past'
  | 'date_before_lead_time'
  | 'date_beyond_horizon'
  | 'date_closed_day'
  | 'date_closure'
  // Time
  | 'time_unparseable'
  | 'time_not_on_slot_boundary'
  | 'time_outside_hours'
  | 'time_after_last_seating'
  | 'time_before_lead_time'
  // Party
  | 'party_unparseable'
  | 'party_too_small'
  | 'party_too_large'
  // Name
  | 'name_unparseable'
  | 'name_too_long'
  | 'name_invalid_characters'
  // Phone
  | 'phone_unparseable'
  | 'phone_too_short'
  | 'phone_too_long'
  // Availability and commit preconditions
  | 'no_availability'
  | 'slots_incomplete'
  | 'not_confirming'
  | 'confirmation_not_affirmative'
  | 'already_committed'
  | 'conversation_ended';

export interface Rejection {
  readonly reason: RejectionReason;
  /** Present when the rejection is attributable to one slot. */
  readonly field?: SlotName;
  /** What the model or visitor supplied, truncated. Shown in the transcript. */
  readonly supplied?: string;
  /** Plain-English explanation, safe to display. Never spoken verbatim. */
  readonly detail: string;
}

export type Validated<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly rejection: Rejection };

export const ok = <T>(value: T): Validated<T> => ({ ok: true, value });
export const fail = <T>(rejection: Rejection): Validated<T> => ({ ok: false, rejection });

/* ------------------------------------------------------------ tool calls -- */

/** The five tools a brain may call. Anything else is `unknown_tool`. */
export type ToolName =
  | 'propose_slots'
  | 'check_availability'
  | 'request_confirmation'
  | 'commit_booking'
  | 'escalate';

/**
 * Deliberately loose. This is the untrusted boundary (plan §7.4): a tool call
 * arrives as whatever the model emitted, including a name that isn't a tool and
 * arguments that aren't an object. Narrowing happens inside the engine.
 */
export interface ToolCall {
  readonly name: string;
  readonly arguments: unknown;
}

/* ----------------------------------------------------------------- lines -- */

/**
 * Every line the agent can say, as a key.
 *
 * The engine decides *what must be said next*; `src/config/phrases.ts` decides
 * *how it is worded*. Keeping those apart is what lets the build-time audio
 * cache exist (T-081) — a key maps to a baked clip — and it keeps copy changes
 * out of the tested core.
 */
export type PhraseKey =
  | 'greeting'
  | 'greeting_returning'
  | 'ask_date'
  | 'ask_time'
  | 'ask_party'
  | 'ask_name'
  | 'ask_phone'
  | 'ask_date_again'
  | 'ask_time_again'
  | 'ask_party_again'
  | 'ask_name_again'
  | 'ask_phone_again'
  | 'readback'
  | 'readback_again'
  | 'booked'
  | 'reject_date_past'
  | 'reject_date_closed'
  | 'reject_date_closure'
  | 'reject_date_horizon'
  | 'reject_time_hours'
  | 'reject_time_last_seating'
  | 'reject_party_large'
  | 'reject_party_small'
  | 'reject_phone_length'
  | 'no_availability_with_alternatives'
  | 'no_availability_other_day'
  | 'no_availability_none'
  | 'escalate_large_party'
  | 'escalate_general'
  | 'ask_disambiguate'
  | 'not_understood'
  | 'not_understood_offer_typing'
  | 'switching_to_typing'
  | 'still_there'
  | 'deflect'
  | 'abandoned'
  | 'filler_checking'
  | 'filler_moment'
  | 'changed_needs_reconfirm';

export type LineParams = Readonly<Record<string, string | number>>;

/** What the engine wants said, and the facts needed to word it. */
export interface AgentLine {
  readonly key: PhraseKey;
  readonly params: LineParams;
}

/* --------------------------------------------------------------- booking -- */

export interface Booking {
  readonly id: string;
  readonly reference: string;
  readonly date: IsoDate;
  readonly time: ClockTime;
  readonly partySize: number;
  readonly name: string;
  readonly phone: string;
  readonly tableId: string;
  readonly durationMinutes: number;
  readonly createdAt: string;
  readonly source: 'voice' | 'typed';
  readonly brain: 'llm' | 'rule' | 'mixed';
  readonly outcome: Outcome;
  readonly seeded: boolean;
}

/** The slice of a booking that availability actually needs. */
export interface DiaryEntry {
  readonly date: IsoDate;
  readonly time: ClockTime;
  readonly tableId: string;
  readonly durationMinutes: number;
}

/* ---------------------------------------------------------- availability -- */

export interface AvailabilityRequest {
  readonly date: IsoDate;
  readonly time: ClockTime;
  readonly partySize: number;
}

export interface Alternative {
  readonly date: IsoDate;
  readonly time: ClockTime;
}

export type AvailabilityResult =
  | { readonly available: true; readonly tableId: string; readonly durationMinutes: number }
  | {
      readonly available: false;
      readonly rejection: Rejection;
      /** Up to three, ordered nearest-first. Empty when nothing was found. */
      readonly alternatives: readonly Alternative[];
    };

/* ----------------------------------------------------------------- state -- */

export interface BookingDraft {
  readonly date: IsoDate;
  readonly time: ClockTime;
  readonly partySize: number;
  readonly name: string;
  readonly phone: string;
  readonly tableId: string;
  readonly durationMinutes: number;
}

export interface EngineState {
  readonly phase: Phase;
  readonly slots: Slots;
  readonly slotStates: SlotStates;
  readonly pendingConfirmation?: BookingDraft;
  readonly alternatives: readonly Alternative[];
  /** How many times each slot has been asked for. Drives re-prompt escalation. */
  readonly attempts: Readonly<Record<SlotName, number>>;
  readonly consecutiveFailures: number;
  /** True once the read-back has been offered at least once. */
  readonly readbackOffered: boolean;
  /** How the visitor answered the most recent read-back. */
  readonly lastAffirmation: Affirmation;
  /**
   * Slot values already proposed during the current visitor turn.
   *
   * Exists so that a second `propose_slots` contradicting the first within one
   * turn is refused rather than silently overwriting — adversarial case 14. A
   * model that changes its mind mid-turn has not heard new information; the
   * visitor only spoke once.
   */
  readonly proposedThisTurn: Readonly<Partial<Record<SlotName, string>>>;
  /** Every proposal the engine refused, in order. Surfaced in the transcript. */
  readonly rejections: readonly Rejection[];
  readonly committed?: Booking;
  readonly outcome?: Outcome;
  /** One off-topic deflection is allowed; never two in a row (plan §4.3). */
  readonly deflectedLastTurn: boolean;
}

export type Affirmation = 'yes' | 'no' | 'none';

/* ---------------------------------------------------------------- events -- */

export type EngineEvent =
  /** Begin the conversation. */
  | { readonly type: 'start' }
  /**
   * What the visitor actually said, before any brain touched it.
   *
   * The engine classifies the affirmation from this raw text itself rather than
   * believing a brain that claims "they said yes" — adversarial case 3.
   */
  | { readonly type: 'visitor_turn'; readonly text: string }
  /** A brain's proposal, in the shape a model would emit it. */
  | { readonly type: 'tool_call'; readonly call: ToolCall }
  /** A turn nobody could make sense of: silence, noise, gibberish. */
  | { readonly type: 'no_input' }
  /** The visitor asked something unrelated to booking. */
  | { readonly type: 'off_topic' }
  /** "Cancel", "never mind". */
  | { readonly type: 'abandon' };

/* --------------------------------------------------------------- effects -- */

export type Effect =
  /** Say this. The orchestrator resolves the key to words and audio. */
  | { readonly type: 'say'; readonly line: AgentLine }
  /** Write this booking. The repository is a scribe; the decision was here. */
  | { readonly type: 'commit'; readonly booking: Booking }
  /** Announce a slot change to assistive technology. */
  | { readonly type: 'announce'; readonly slot: SlotName; readonly state: SlotState }
  /** Hand control to the typed path. */
  | { readonly type: 'offer_typing' }
  | { readonly type: 'end'; readonly outcome: Outcome };

export interface EngineResult {
  readonly state: EngineState;
  readonly effects: readonly Effect[];
  /** Rejections produced by *this* event, for the turn's transcript entry. */
  readonly rejections: readonly Rejection[];
}

/* ------------------------------------------------------------------ deps -- */

export interface EngineDeps {
  readonly clock: Clock;
  readonly config: RestaurantConfig;
  /** Existing bookings, including the seeded demo diary. */
  readonly diary: readonly DiaryEntry[];
  readonly ids: IdSource;
  /** Recorded on the booking; the engine does not otherwise care. */
  readonly source: 'voice' | 'typed';
  readonly brain: 'llm' | 'rule' | 'mixed';
}
