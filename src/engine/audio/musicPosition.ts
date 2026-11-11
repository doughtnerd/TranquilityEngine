/**
 * Musical positions (ADR 0166, `docs/design/0166-audio-music/api-and-models.md` §2.2): the string `"bar:beat:tick"`.
 *
 * Bar 1-based, beat 1-based within the bar's metre, tick 0..959 (`MUSIC_TICKS_PER_BEAT` per beat, the beat being the
 * `beatUnit` note). `"1:1:0"` is the start of the grid. Two words stand in for a position where the format allows them:
 * `"start"` (the start of the file) and `"end"` (the end of the audio; valid for `cues[].at` and `regions[].to`).
 *
 * This module is the grammar only: parse, format, compare. It knows nothing of metre (a beat past the bar's
 * `beatsPerBar` is G1's check, `musicGrid.ts`), tempo or clips. Pure; never throws.
 *
 * Stubs tagged `L-F1ab` are filled by that leaf; the signatures, types and constants are the lead's contract.
 */

/** Ticks per beat (§2.2). The beat is the `beatUnit` note. */
export const MUSIC_TICKS_PER_BEAT = 960;
/** Largest `beatsPerBar` (§2.3), so the largest beat a position may name. */
export const MAX_POSITION_BEAT = 32;
/** Largest bar number a position may name (a format sanity bound, not in the spec; 99,999 bars is hours of music). */
export const MAX_POSITION_BAR = 99_999;

/** A parsed `"bar:beat:tick"`. Integers: `bar` 1..`MAX_POSITION_BAR`, `beat` 1..`MAX_POSITION_BEAT`, `tick` 0..959. */
export interface BarBeatTick {
  bar: number;
  beat: number;
  tick: number;
}

/** The two words that may stand in for a position. */
export type PositionWord = "start" | "end";
export const POSITION_WORDS: readonly PositionWord[] = ["start", "end"];

/** A parsed position: bar, beat and tick, or one of the words. */
export type MusicPosition = BarBeatTick | PositionWord;

/** Which words a field accepts. Absent or false: that word is a problem. */
export interface PositionAllow {
  start?: boolean;
  end?: boolean;
}

/** True for a parsed `bar:beat:tick` (not a word). */
export const isBarBeatTick = (p: MusicPosition): p is BarBeatTick => typeof p !== "string";

/**
 * Parse a position. Strict about shape: exactly `digits:digits:digits` with no sign, no space, no fraction; leading
 * zeros are accepted (`"01:1:000"` is `1:1:0`). A word (`"start"`, `"end"`) parses only when `allow` names it.
 * Returns null when `raw` is not a string, is malformed, or is out of range (bar 0 or past `MAX_POSITION_BAR`,
 * beat 0 or past `MAX_POSITION_BEAT`, tick past 959). Spec rule: §2.2.
 */
export function parsePosition(raw: unknown, allow?: PositionAllow): MusicPosition | null {
  const result = diagnosePosition(raw, allow);
  return "position" in result ? result.position : null;
}

/** One reading of a field: the position, or the problem fragment. Shared by parsePosition and positionProblem. */
type PositionReading = { position: MusicPosition } | { problem: string };

const POSITION_SHAPE = /^(\d+):(\d+):(\d+)$/;

/** The fragment naming what a position must look like, with the words the field allows. */
function expectedPosition(allow?: PositionAllow): string {
  const shape = `"bar:beat:tick" (bar 1 or more, beat 1..${MAX_POSITION_BEAT}, tick 0..${MUSIC_TICKS_PER_BEAT - 1})`;
  const words = POSITION_WORDS.filter((w) => allow?.[w] === true).map((w) => `"${w}"`);
  return words.length > 0 ? `${shape} or ${words.join(" or ")}` : shape;
}

function diagnosePosition(raw: unknown, allow?: PositionAllow): PositionReading {
  const must = `must be ${expectedPosition(allow)}`;
  if (typeof raw !== "string") return { problem: must };
  if ((POSITION_WORDS as readonly string[]).includes(raw)) {
    return allow?.[raw as PositionWord] === true
      ? { position: raw as PositionWord }
      : { problem: `"${raw}" is not allowed here; ${must}` };
  }
  const match = POSITION_SHAPE.exec(raw);
  if (match === null) {
    // Name the part that is not a whole number when the text has the three colon-separated parts.
    const parts = raw.split(":");
    if (parts.length === 3) {
      const names = ["bar", "beat", "tick"];
      const bad = parts.findIndex((part) => !/^\d+$/.test(part));
      if (bad >= 0) return { problem: `${names[bad]} "${parts[bad]}" is not a whole number; ${must}` };
    }
    return { problem: must };
  }
  const bar = Number(match[1]);
  const beat = Number(match[2]);
  const tick = Number(match[3]);
  if (bar < 1) return { problem: `bar ${bar} is below 1` };
  if (bar > MAX_POSITION_BAR) return { problem: `bar ${bar} is past ${MAX_POSITION_BAR}` };
  if (beat < 1) return { problem: `beat ${beat} is below 1` };
  if (beat > MAX_POSITION_BEAT) return { problem: `beat ${beat} is past ${MAX_POSITION_BEAT}` };
  if (tick > MUSIC_TICKS_PER_BEAT - 1) return { problem: `tick ${tick} is past ${MUSIC_TICKS_PER_BEAT - 1}` };
  return { position: { bar, beat, tick } };
}

/**
 * Why `raw` is not a valid position, as a sentence fragment for a problem message, e.g. `must be "bar:beat:tick"
 * (bar 1 or more, beat 1..32, tick 0..959)` or `tick 960 is past 959`; null when `parsePosition(raw, allow)` succeeds.
 * Names the words the field allows. The caller prefixes the path and appends its own consequence ("dropped").
 */
export function positionProblem(raw: unknown, allow?: PositionAllow): string | null {
  const result = diagnosePosition(raw, allow);
  return "problem" in result ? result.problem : null;
}

/**
 * The canonical text of a position: `"bar:beat:tick"` with no leading zeros, or the word. `parsePosition(formatPosition(p))`
 * round-trips (with the word allowed). Spec rule: §2.2.
 */
export function formatPosition(p: MusicPosition): string {
  return isBarBeatTick(p) ? `${p.bar}:${p.beat}:${p.tick}` : p;
}

/** `formatPosition(parsePosition(raw, allow))`, or null when `raw` is not valid: the form the file stores. */
export function canonicalPosition(raw: unknown, allow?: PositionAllow): string | null {
  const p = parsePosition(raw, allow);
  return p === null ? null : formatPosition(p);
}

/**
 * Order two `bar:beat:tick` positions: negative when `a` is before `b`, 0 when equal, positive when after. Bar, then
 * beat, then tick. Valid without a metre because a beat never exceeds its bar. (Words are not comparable: the callers
 * place `start` first and `end` last themselves.)
 */
export function comparePositions(a: BarBeatTick, b: BarBeatTick): number {
  return a.bar - b.bar || a.beat - b.beat || a.tick - b.tick;
}

/** The same beat with tick 0 (a tempo marker "sits on a beat", §2.2). */
export function snapToBeat(p: BarBeatTick): BarBeatTick {
  return { bar: p.bar, beat: p.beat, tick: 0 };
}

/**
 * Beat 1 tick 0 of the bar after `p`'s (a metre change not on beat 1 "snaps to the next bar", §2.2). A position that is
 * already beat 1 tick 0 is returned unchanged: it already sits on a bar.
 */
export function snapToNextBar(p: BarBeatTick): BarBeatTick {
  if (p.beat === 1 && p.tick === 0) return p;
  return { bar: p.bar + 1, beat: 1, tick: 0 };
}
