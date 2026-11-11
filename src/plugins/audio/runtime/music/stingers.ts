/**
 * Stingers and `handle.trigger` (ADR 0166 api-and-models §1.2 `trigger`, §2.5; architecture §3.4).
 *
 * Owner: **R5** (W6), with the pure decision table in `stingerPolicy.ts` (leaf L-R5a). Q2 wrote the skeleton.
 *
 * `trigger` names are one namespace per event; with several matches the deepest container above the playing segment
 * wins, then list order. A stinger is quantised to its `at` (a `GridSpec`, `immediate` or the next `{cue}`), honours
 * `dontRepeat` and `ifTooLate`, plays on its own voices and bus over the music, never changes the grid, and at most 4
 * sound at once per instance (the fifth steals the oldest with a 5 ms fade). A refused stinger is dropped.
 */
import type { AudioVoice } from "../backend";
import { playerOf, type MusicFrame, type MusicPlayer } from "./musicSystem";

/** At most this many stingers sound at once per instance (§2.5, R20). */
export const MAX_STINGERS = 4;

/** A stinger waiting for its grid point, or sounding. */
export interface StingerEntry {
  /** The stinger's `trigger` name. */
  readonly trigger: string;
  /** Library id of its segment. */
  readonly segment: string;
  /** Heard time (seconds) it is (or was) stamped at; NaN while not yet planned. */
  at: number;
  /** Its voices once stamped. */
  voices: AudioVoice[];
}

/** The player's stinger queue and `dontRepeat` stamps. R5 may add fields here. */
export interface StingerState {
  readonly queued: StingerEntry[];
  readonly sounding: StingerEntry[];
  /** Trigger name → heard time (seconds) it last played, for `dontRepeat`. */
  readonly lastPlayed: Map<string, number>;
}

/** R5: an empty stinger state. */
export function createStingerState(): StingerState {
  return { queued: [], sounding: [], lastPlayed: new Map() };
}

/**
 * R5: fire the stinger whose `trigger` is `name`. True when accepted; false when unknown, dropped by `dontRepeat` or
 * `ifTooLate: "skip"`, or the pool refused it (the counters say which).
 */
export function triggerStinger(player: MusicPlayer, name: string): boolean {
  void player;
  void name;
  return false; // STUB(R5)
}

/** `handle.trigger(name)` on any event handle (`Audio.ts`): false for a non-music handle. */
export function triggerOn(instance: object, name: string): boolean {
  const p = playerOf(instance);
  return p !== null && triggerStinger(p, name);
}

/** R5, step 9: plan and stamp queued stingers at their grid points; forget ended ones. */
export function tickStingers(player: MusicPlayer, f: MusicFrame): void {
  void player;
  void f;
  // STUB(R5)
}
