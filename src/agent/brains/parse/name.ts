/**
 * Names, out of speech.
 *
 * The name is the one slot whose value is neither a number nor drawn from a
 * closed set, so it is the only one where "whatever the visitor said" could
 * reach the diary, the read-back and the transcript more or less intact. That
 * makes this file the narrowest place to constrain it (plan §13), and it is
 * why the character restriction lives here rather than in a renderer: by the
 * time a string is being drawn it has already been copied into state.
 *
 * Three jobs, in order:
 *
 *   1. Strip the filler people wrap a name in — "it's under…", "put it down
 *      for…" — without stripping anything that could itself be a name.
 *   2. Repair spell-outs. "K-A-R-A-N-I" is not six initials, and a spell-out
 *      that follows a word is a correction of that word, not a second name.
 *   3. Restore capitalisation, because recognisers return lowercase and a
 *      confirmation email addressed to "priya karani" reads as a bug.
 *
 * Everything here is a candidate only. Whether a name is *acceptable* is
 * `src/engine/validate.ts`'s call, and it re-checks length and characters
 * itself rather than trusting this file (plan §7.2).
 */

import type { ParseContext, ParseResult } from './types.js';
import { ambiguous, normalise, notFound, parsed } from './types.js';

/** Plan §10.2: 1–60 characters after trimming. */
const MAX_NAME = 60;

/**
 * Nothing longer than this is examined at all.
 *
 * A name of 60 characters plus the wordiest filler anyone actually says
 * ("hi there, could you put the booking down under…") is nowhere near 300, so
 * a longer string is a paste, a transcription runaway, or someone probing.
 * Bailing before the first regex runs is what keeps the 5,000-character case
 * from being a performance question at all.
 */
const MAX_INPUT = 300;

/**
 * Real names run to four words; five or six with particles ("de la Cruz").
 * Beyond that the visitor answered a different question — "I would like to
 * book a table for four" — and booking a table under a sentence is a worse
 * failure than asking again. This cap will occasionally refuse a genuinely
 * long name; that trade is deliberate, and the re-prompt recovers it.
 */
const MAX_WORDS = 6;

/**
 * Letters (any script, so accented Latin and non-Latin names both survive),
 * plus combining marks, spaces, hyphens, apostrophes and periods. Everything
 * else — angle brackets, braces, backticks, dollar signs, digits, slashes —
 * fails the whole candidate rather than being scrubbed out of it. Scrubbing
 * would hand back a plausible-looking name built from an implausible input,
 * which is exactly the thing that gets rendered without a second glance.
 */
const ALLOWED = /^[\p{L}\p{M}'. -]+$/u;

const ALL_DIGITS = /^\d+$/;

/** Four digits in a row is a phone number in the wrong slot, not a name. */
const DIGIT_RUN = /\d{4,}/;

/** A single spoken letter, with or without the period a recogniser adds. */
const LETTER_TOKEN = /^\p{L}\.?$/u;

/**
 * A spell-out that arrived as one token: `k-a-r-a-n-i`, `k.a.r.a.n.i.`
 *
 * Bounded on purpose. `(?:[-.]\p{L})+` would be equivalent and would also give
 * a crafted 300-character run of hyphens somewhere to backtrack; 29 is well
 * past the longest name anyone spells aloud.
 */
const JOINED_SPELL = /^\p{L}(?:[-.]\p{L}){2,29}\.?$/u;

/**
 * What people say between a name and its spelling. Matched with surrounding
 * whitespace so it only ever splits mid-utterance — a leading "that's" is
 * filler and is removed before we get here.
 */
const SPELL_MARKER = /\s(?:that is|that's|thats|spelt|spelled|spelling|as in|which is)\s/;

/**
 * Answers that are not names.
 *
 * Without this the agent will cheerfully book a table under "Yes", because
 * "yes" is four allowed characters in a row and nothing else in the pipeline
 * has an opinion. Single letters are rejected separately.
 */
const STOP: ReadonlySet<string> = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'no',
  'nope',
  'nah',
  'ok',
  'okay',
  'sure',
  'thanks',
  'thank you',
  'hello',
  'hi',
  'hey',
  'please',
  'maybe',
  'dunno',
  'nothing',
  'none',
  'whatever',
  'idk',
]);

/**
 * "Karani or Sharma" is two names and no way to choose. Splitting on these
 * and refusing is the whole point of `ambiguous` existing.
 */
const COORDINATORS: ReadonlySet<string> = new Set(['or', 'and', 'slash', 'either']);

/**
 * Ordered, anchored, and all literal alternations — no nested quantifiers, so
 * a failed match costs one pass over a prefix and nothing more.
 *
 * Every one of these requires trailing whitespace, which is what stops "just"
 * from eating the start of "Justin" or "yes" the start of "Yesenia".
 */
const PREFIXES: readonly RegExp[] = [
  // Discourse noise: "um", "yeah,", "hi there" is not covered and does not need to be.
  /^(?:um|uh|erm|er|ah|oh|well|so|yeah|yea|yep|yes|ok|okay|right|hi|hello|hey)\b[\s.]+/,
  /^(?:it is|it's|its|that is|that's|thats|this is)\s+/,
  // "the name's", "my name is", "surname", "last name", "first name".
  /^(?:the |my |our )?(?:full |first |last |sur|family |given )?name(?:'s| is| was| would be| will be)?\s+/,
  /^(?:put|pop|write|stick|book|set|note)\s+(?:it|me|us|them|that|this)?\s*(?:down\s+)?(?:under|for|as|in)\s+/,
  /^(?:booking|reservation|table|reserve)\s+(?:is\s+)?(?:for|under)\s+/,
  /^(?:call me|i'm|im|i am|we're|we are)\s+/,
  /^(?:under|for|as)\s+/,
  /^just\s+/,
];

const SUFFIXES: readonly RegExp[] = [
  /[\s.]+(?:please|thanks|thank you|cheers|ta)$/,
  /[\s.]+(?:if that's ok|if that's okay|if you would)$/,
];

/**
 * Parses a name, or declines to.
 *
 * `ctx` is unused: a name means the same thing on every date, at every hour,
 * in every restaurant. It stays in the signature because every parser has the
 * same shape and a caller should not have to remember which ones need it.
 */
export function parseName(text: string, _ctx: ParseContext): ParseResult<string> {
  if (text.length === 0 || text.length > MAX_INPUT) return notFound();

  const normalised = normalise(text);
  if (normalised.length === 0) return notFound();

  // Checked before anything else touches the string: a phone number read into
  // the name slot should fail as a phone number, not be partially salvaged.
  if (ALL_DIGITS.test(normalised) || DIGIT_RUN.test(normalised)) return notFound();

  const stripped = stripFiller(normalised);
  if (stripped.length === 0) return notFound();

  const tokens = repairSpelling(stripped);
  const groups = splitOnCoordinators(tokens);

  if (groups.length > 1) {
    const candidates: string[] = [];
    for (const group of groups) {
      const name = finalise(group);
      if (name !== null && !candidates.includes(name)) candidates.push(name);
    }
    if (candidates.length > 1) {
      return ambiguous(candidates, 'more than one name offered, with nothing said to choose between them');
    }
    const only = candidates[0];
    return only === undefined ? notFound() : parsed(only, text.trim());
  }

  // `groups[0]` rather than `tokens`: a coordinator with nothing on one side
  // of it — "and Karani" — is filler, and must not survive into the name.
  const name = finalise(groups[0] ?? []);
  return name === null ? notFound() : parsed(name, text.trim());
}

/* --------------------------------------------------------------- filler -- */

function stripFiller(input: string): string {
  let current = input;
  // Filler nests — "it's under" is two layers — but not deeply. Each pass
  // removes at most one prefix and one suffix; the bound is what stops a
  // crafted string from finding a cycle here.
  for (let pass = 0; pass < 6; pass += 1) {
    const before = current;
    current = stripOnce(current, PREFIXES);
    current = stripOnce(current, SUFFIXES);
    if (current === before) break;
  }
  return current;
}

function stripOnce(input: string, patterns: readonly RegExp[]): string {
  for (const pattern of patterns) {
    const next = input.replace(pattern, '');
    if (next !== input) return next.trim();
  }
  return input;
}

/* -------------------------------------------------------------- spelling -- */

/**
 * Turns spell-outs into words and, where a spell-out follows a spoken name,
 * uses it to repair that name rather than to add a second one.
 */
function repairSpelling(input: string): readonly string[] {
  const marker = SPELL_MARKER.exec(input);
  if (marker === null) return collapseSpelling(split(input));

  const matched = marker[0];
  const left = collapseSpelling(split(input.slice(0, marker.index)));
  const rightTokens = split(input.slice(marker.index + matched.length));
  const spelled = spellOut(rightTokens);

  if (spelled === null) {
    // "Karani, that's right." The tail is not a spelling, so the name was
    // already complete and the tail is conversation. Dropping it beats
    // guessing what part of it was meant to be a name.
    return left.length > 0 ? left : collapseSpelling(rightTokens);
  }

  const last = left[left.length - 1];
  if (last === undefined) return [spelled];

  // Does the spelling repair the last word, or add to it? "Karan → K-A-R-A-N-I"
  // is a correction; "Priya → K-A-R-A-N-I" is a surname being spelled after a
  // first name. Sharing a first letter, or one being a prefix of the other, is
  // a crude test, but it is the signal a listener actually uses.
  const repairs = last.charAt(0) === spelled.charAt(0) || last.startsWith(spelled) || spelled.startsWith(last);
  return repairs ? [...left.slice(0, -1), spelled] : [...left, spelled];
}

/**
 * Collapses runs of single letters into words, in place, so that
 * "priya k a r a n i" becomes two tokens rather than seven.
 *
 * Three is the threshold because two single letters are initials — "J R
 * Karani" — and joining those would invent a name nobody said.
 */
function collapseSpelling(tokens: readonly string[]): readonly string[] {
  const out: string[] = [];
  let run: string[] = [];

  const flush = (): void => {
    if (run.length >= 3) out.push(run.join(''));
    else out.push(...run);
    run = [];
  };

  for (const token of tokens) {
    if (LETTER_TOKEN.test(token)) {
      run.push(token.replace(/\./g, ''));
      continue;
    }
    flush();
    out.push(JOINED_SPELL.test(token) ? token.replace(/[-.]/g, '') : token);
  }
  flush();
  return out;
}

/** The word these tokens spell, if spelling is all they do. */
function spellOut(tokens: readonly string[]): string | null {
  if (tokens.length === 1) {
    const only = tokens[0];
    if (only !== undefined && JOINED_SPELL.test(only)) return only.replace(/[-.]/g, '');
    return null;
  }
  if (tokens.length < 3) return null;

  const letters: string[] = [];
  for (const token of tokens) {
    if (!LETTER_TOKEN.test(token)) return null;
    letters.push(token.replace(/\./g, ''));
  }
  return letters.join('');
}

/* ------------------------------------------------------------ ambiguity -- */

function splitOnCoordinators(tokens: readonly string[]): readonly (readonly string[])[] {
  if (!tokens.some((token) => COORDINATORS.has(token))) return [tokens];

  const groups: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (COORDINATORS.has(token)) {
      if (current.length > 0) groups.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/* ---------------------------------------------------------- final checks -- */

/** The candidate, cleaned and capitalised, or null if it is not a name. */
function finalise(tokens: readonly string[]): string | null {
  const candidate = tokens.join(' ').trim();
  if (candidate.length === 0) return null;

  // Refused, not truncated. A truncated name is worse than no name: it reads
  // back as if it were correct, the visitor hears something close enough to
  // their own name to say yes, and the diary ends up with a booking nobody
  // can be identified by. Asking again costs one turn.
  if (candidate.length > MAX_NAME) return null;

  if (!ALLOWED.test(candidate)) return null;

  const bare = candidate.replace(/[.']/g, '').trim();
  // One letter is an initial or a recogniser artefact, never a name.
  if (bare.length <= 1) return null;
  if (STOP.has(bare)) return null;

  const words = split(bare);
  if (words.length === 0 || words.length > MAX_WORDS) return null;
  if (words.every((word) => STOP.has(word))) return null;

  return capitalise(candidate);
}

/* ------------------------------------------------------- capitalisation -- */

function capitalise(value: string): string {
  return split(value)
    .map((word) =>
      word
        .split('-')
        .map(capitaliseSegment)
        .join('-'),
    )
    .join(' ');
}

function capitaliseSegment(segment: string): string {
  let out = '';
  let atBoundary = true;
  const characters = [...segment];

  for (let i = 0; i < characters.length; i += 1) {
    const character = characters[i];
    if (character === undefined) continue;
    out += atBoundary ? character.toUpperCase() : character.toLowerCase();

    // O'Brien, D'Angelo, J.R. — a letter after one of these starts a new part.
    //
    // Except a trailing possessive: an apostrophe followed by a final "s" is
    // "'s", not the start of a name, so "what's" must not become "What'S".
    // Names ending in "'s" are vanishingly rare; possessives reaching this
    // parser are not.
    const isPossessive = character === "'" && i === characters.length - 2 && characters[i + 1]?.toLowerCase() === 's';
    atBoundary = (character === "'" || character === '.') && !isPossessive;
  }

  return applyMc(out);
}

/**
 * "mcdonald" → "McDonald".
 *
 * A heuristic, and dishonest to describe as anything else. It is right for
 * McDonald, McGregor and McIntyre and wrong for anyone whose name is genuinely
 * spelled Mcintyre or Mcauley — and there is no way to tell the two apart from
 * a lowercase transcript, because the distinction lives in the spelling that
 * the recogniser has already discarded. It is applied because "Mcdonald"
 * is wrong for almost everyone, whereas this is wrong for a few; the
 * confirmation step is where the visitor gets to say so.
 *
 * Mac- is deliberately left alone: Macey, Mackie and Macron are far more
 * common than the MacKenzie spelling, so the same trade comes out the other way.
 */
function applyMc(segment: string): string {
  const match = /^Mc(\p{L})(\p{L}+)$/u.exec(segment);
  if (match === null) return segment;
  const initial = match[1];
  const rest = match[2];
  if (initial === undefined || rest === undefined) return segment;
  return `Mc${initial.toUpperCase()}${rest}`;
}

/* ---------------------------------------------------------------- utils -- */

function split(value: string): string[] {
  return value.split(' ').filter((token) => token.length > 0);
}
