/**
 * Stems of a playing segment (ADR 0166 api-and-models §2.3 tracks, §10 P5 and R6; architecture §2.3 ring release).
 *
 * Owners: **P5** (W4) fills the ring release and solo gain; **R6** (W6) fills `quantizedRamp` (the `quantize` key on
 * automation bindings: a stamped in-voice ramp at the next grid point; it also edits `events/automation.ts`). Q2 wrote
 * the skeleton. Per-stem automation itself is 0158's.
 */
import type { GridSpec } from "../../../../engine/audio/musicTypes";
import type { MusicFrame, MusicPlayer } from "./musicSystem";
import type { StemRun } from "./segmentRun";

/** P5: a stem that is silent (its gain at 0 for its fade) returns its ring when its voice ends; true when released. */
export function releaseSilentRing(stem: StemRun, f: MusicFrame): boolean {
  void stem;
  void f;
  return false; // STUB(P5)
}

/** P5: solo one stem (others to 0 with a fade), or clear the solo with null. */
export function soloStem(player: MusicPlayer, track: string | null, fadeSeconds: number): void {
  void player;
  void track;
  void fadeSeconds;
  // STUB(P5)
}

/**
 * R6: an automation binding with `quantize` (`beat` or `bar`) moves a stem's gain at the next grid point of `grid` as a
 * stamped in-voice ramp (sample-exact on the line). Returns the heard time it lands, NaN when not playing.
 */
export function quantizedRamp(player: MusicPlayer, track: string, to: number, grid: GridSpec, seconds: number, f: MusicFrame): number {
  void player;
  void track;
  void to;
  void grid;
  void seconds;
  void f;
  return Number.NaN; // STUB(R6)
}

/** P5, R6, step 9: release silent stems' rings, commit due quantised ramps. */
export function tickStems(player: MusicPlayer, f: MusicFrame): void {
  void player;
  void f;
  // STUB(P5)
}
