/**
 * Loop regions: `count` and `while` (ADR 0166 api-and-models §2.3 regions; architecture §3.5).
 *
 * Owners: **P3** counts `count` passes and predicts wraps (`anchors.ts`); **R4b** (W8) fills `while` regions here. Q2
 * wrote the skeleton.
 *
 * A `while` region's condition is read one lead before the loop end (the commit point); once false the region is
 * released through the region-release splice (`decoder/streams.ts`, `stream.rs`). A flag set after the commit waits one
 * more pass (stated latency). A seek into a `count` region restarts its pass count; into a `while` region the condition
 * is read at the next commit point.
 */
import type { MusicFrame, MusicPlayer } from "./musicSystem";

/** The playing segment's region state. R4b may add fields here. */
export interface RegionState {
  /** Index of the region the playhead is in, -1 outside any. */
  region: number;
  /** Passes done in that region. */
  passes: number;
  /** Heard time (seconds) of the next commit point (one lead before the loop end); NaN: none. */
  commitAt: number;
  /** The region was released (plays on past its end). */
  released: boolean;
}

/** R4b: a region state for a new run. */
export function createRegionState(): RegionState {
  return { region: -1, passes: 0, commitAt: Number.NaN, released: false };
}

/** R4b, step 9: at a `while` region's commit point, read the condition; false releases the region. */
export function tickRegions(player: MusicPlayer, f: MusicFrame): void {
  void player;
  void f;
  // STUB(R4b)
}
