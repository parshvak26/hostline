/**
 * The contract every parser implements.
 *
 * Parsers live outside `src/engine/` on purpose. Understanding what someone
 * *meant* is a judgement call; deciding whether it is *allowed* is not. The
 * parsers turn speech into candidate values and stop there — `src/engine/`
 * decides whether a value survives (plan §7.2).
 *
 * So a party size of forty parses fine. It is rejected one layer up, by the
 * validator, which is the layer with tests that a hostile model has to beat.
 */

import type { ClockTime, IsoDate, RestaurantConfig } from '../../../engine/types.js';

/**
 * Deliberately three-valued.
 *
 * `ambiguous` exists because "four or five of us" and "Friday" (which Friday?)
 * are not failures — they are questions. A parser that guessed would move a
 * wrong value into a slot and make the agent sound confidently incorrect, which
 * is the single worst failure this project can have.
 */
export type ParseResult<T> =
  | { readonly kind: 'ok'; readonly value: T; readonly matched: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly T[]; readonly note: string }
  | { readonly kind: 'none' };

export const parsed = <T>(value: T, matched: string): ParseResult<T> => ({ kind: 'ok', value, matched });

export const ambiguous = <T>(candidates: readonly T[], note: string): ParseResult<T> => ({
  kind: 'ambiguous',
  candidates,
  note,
});

export const notFound = <T>(): ParseResult<T> => ({ kind: 'none' });

export interface ParseContext {
  /** Today, in the restaurant's timezone. */
  readonly today: IsoDate;
  /** The current local time, used for "tonight" and lead-time reasoning. */
  readonly nowTime: ClockTime;
  readonly config: RestaurantConfig;
  /**
   * The date the conversation has settled on, when there is one. The time
   * parser uses it to resolve a bare "seven" against that day's actual service
   * windows rather than against a guess.
   */
  readonly date?: IsoDate;
}

/** Everything a parser is handed for one visitor turn. */
export interface Utterance {
  readonly text: string;
  readonly normalised: string;
}

/**
 * Lowercase, strip punctuation that never carries meaning here, collapse
 * whitespace. Kept in one place so every parser sees the same string — a
 * mismatch between two parsers' idea of "normalised" is a bug that only shows
 * up in the awkward fixtures.
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/[,;!?"“”()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function utterance(text: string): Utterance {
  return { text, normalised: normalise(text) };
}
