/**
 * Grid anchors, counted loop regions and wrap prediction (ADR 0166 api-and-models §3.2 `GridAnchor`; architecture §4.5
 * "Model", §3.7 rate change).
 *
 * Owner: **P3** (W4). Q2 wrote the skeleton.
 *
 * An anchor is integer ticks from the segment's bar 1 beat 1 **plus** the heard time it is at, never raw audio frames,
 * so a context rebuild at a new rate recomputes frames through the clock map. Heard time of position p =
 * t0 + sec(p) - sec(p0); a loop pass adds k x the region length; a committed successor has its own anchor. Late starts,
 * holds and abandons shift t0 by their slip (any size; indices never re-fire).
 */
import type { MusicGroupEvent } from "../backend";
import type { MusicPlayer } from "./musicSystem";
import type { SegmentRun } from "./segmentRun";

/** §3.2 `GridAnchor`. */
export interface GridAnchor {
  /** Node id of the anchored segment. */
  readonly segment: string;
  /** Integer ticks from bar 1 beat 1 of the segment (§2.2's ticks per beat). */
  ticks: number;
  /** Heard time (seconds) the position `ticks` is at. */
  time: number;
  /** The loop pass the anchor is in, from 1. */
  pass: number;
}

/** P3: the anchor of a run stamped at `at` (heard seconds) from file frame `startFrame`. */
export function anchorRun(run: SegmentRun, at: number): GridAnchor {
  return { segment: run.node.id, ticks: 0, time: at, pass: 1 }; // STUB(P3): ticks from the start frame, pre-entry
}

/** P3: heard time (seconds) of the position `ticks` (on the anchor's segment, its pass), NaN when unknown. */
export function heardTimeOf(anchor: GridAnchor, ticks: number): number {
  void anchor;
  void ticks;
  return Number.NaN; // STUB(P3)
}

/** P3: the position (ticks) heard at `time` (seconds) on the anchor's segment, NaN when unknown. */
export function ticksAt(anchor: GridAnchor, time: number): number {
  void anchor;
  void time;
  return Number.NaN; // STUB(P3)
}

/** P3: the heard time (seconds) of the next wrap of the playing loop region after `now`, NaN when it doesn't loop. */
export function predictWrap(player: MusicPlayer, now: number): number {
  void player;
  void now;
  return Number.NaN; // STUB(P3)
}

/** P3: a late start, hold or abandon of the player's group shifts its anchor by the slip (architecture §4.5 "Corrections"). */
export function applySlip(player: MusicPlayer, e: Extract<MusicGroupEvent, { slipFrames: number }>, sampleRate: number): void {
  void player;
  void e;
  void sampleRate;
  // STUB(P3)
}

/** P3: a context rebuilt at a new rate: anchors keep their musical position and heard time (within 1 frame). */
export function rebaseAnchors(player: MusicPlayer, sampleRate: number): void {
  void player;
  void sampleRate;
  // STUB(P3)
}
