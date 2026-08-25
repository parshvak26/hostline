/**
 * The engine's entire public surface.
 *
 * Everything outside `src/engine/` imports from here and nowhere else. Keeping
 * the surface in one file makes the boundary something you can read in thirty
 * seconds — which matters, because "the AI proposes, the engine decides" is
 * only a real claim if the decisions are demonstrably all in one place.
 */

export type {
  Affirmation,
  AgentLine,
  Alternative,
  AvailabilityRequest,
  AvailabilityResult,
  Booking,
  BookingDraft,
  ClockTime,
  Clock,
  Closure,
  DiaryEntry,
  Effect,
  EngineDeps,
  EngineEvent,
  EngineResult,
  EngineState,
  IdSource,
  Instant,
  IsoDate,
  LineParams,
  OpeningDay,
  Outcome,
  Phase,
  PhraseKey,
  Rejection,
  RejectionReason,
  RestaurantConfig,
  SeatingPolicy,
  ServicePolicy,
  SlotName,
  SlotState,
  SlotStates,
  Slots,
  TableClass,
  ToolCall,
  ToolName,
  Validated,
  Weekday,
} from './types.js';

export { SLOT_ORDER, ok, fail } from './types.js';

export { initialState, reduce, reduceAll, currentAlternatives } from './machine.js';

export {
  checkAvailability,
  checkDate,
  checkTime,
  closureOn,
  findAlternatives,
  isSeatable,
  turnTimeFor,
  windowsFor,
} from './availability.js';

export {
  preview,
  validateDate,
  validateName,
  validatePartySize,
  validatePhone,
  validateProposal,
  validateTime,
} from './validate.js';
export type { ProposalOutcome } from './validate.js';

export {
  buildDraft,
  buildReadback,
  classifyAffirmation,
  completeSlots,
  draftMatchesSlots,
  isAbandonment,
  slotsComplete,
} from './confirm.js';

export { isOutstanding, nextQuestion, outstandingSlots, recoveryLine, refusalLine } from './prompts.js';
export type { NextQuestion } from './prompts.js';

export {
  addDays,
  compareDates,
  daysBetween,
  daysInMonth,
  formatDateLong,
  formatTime12,
  fromDayNumber,
  isClockTime,
  isIsoDate,
  isLeapYear,
  minutesBetween,
  minutesOf,
  ordinal,
  parseIsoDate,
  spokenDate,
  spokenTime,
  timeFromMinutes,
  toDayNumber,
  toIsoDate,
  weekdayOf,
  MONTH_NAMES,
  WEEKDAYS,
  WEEKDAY_NAMES,
} from './time.js';
export type { CivilDate } from './time.js';
