/**
 * Loop regions: `count` and `while` (ADR 0166 api-and-models §2.3 regions; architecture §3.5, §5.2).
 *
 * Owners: **P3** counts `count` passes and predicts wraps (`anchors.ts`); **R4b** (W8) fills `while` regions here. Q2
 * wrote the skeleton.
 *
 * A `while` region's condition is read one lead before the loop end (the commit point); once false the region is
 * released through the region-release splice (`decoder/streams.ts`, `stream.rs`). A flag set after the commit waits one
 * more pass (stated latency). A seek into a `count` region restarts its pass count; into a `while` region the condition
 * is read at the next commit point.
 *
 * **R4b's model.**
 * - **The commit point** of the next wrap E (`anchors.nextWrapOf`, which unrolls the passes and respects `count`) is
 *   E − L − Δ̄ − 10 ms (architecture §3.5, §5.2: L the look-ahead, Δ̄ the frame interval, 10 ms the splice margin), so
 *   the condition is read in the last display frame whose batch still lands before E. It is read once per wrap: a
 *   change after that waits for the next pass's commit point.
 * - **Late.** A frame that first reaches the commit point with E already inside the look-ahead (a stall over it) reads
 *   nothing for that wrap: the region wraps once more (R13's "a stall over the commit point runs one more pass") and
 *   the condition is read at the next commit point.
 * - **The release.** A false condition marks the region released with its last pass (`lastPass`, the pass E ends) in
 *   the same tick, before `tickLoopTails` (step 9's order): the anchors' walk then drops that region's wraps from E on,
 *   in every query (`predictWrap`, `nextWrapOf`, `advanceAnchor`, `ticksAt` through `bindRelease`), so R4a's walk
 *   releases the members (`AutomationSink.setLoop` with `looping: false`) and stamps no tail at E. A decoded member's
 *   release is a SET_LOOP sent at once: the voice plays on past the region's end instead of wrapping at E. A streamed
 *   member's goes to the worker as the end of its current pass (`streams.setLoop` → `musicOps.setLoop`, the worker's
 *   region-release splice). Either way the segment plays on through the audio after the region (what a tail would
 *   have rung) and on to its exit cue, where the container goes on as at any natural end.
 * - **After it is heard** the anchor moves to the region's end (`anchors.anchorPastRegion`) and the release is
 *   cleared, so later regions (a second `while`) are read the same way.
 * - **The condition.** `{ parameter, is }` matches the parameter's label (or a numeric value's text, as a
 *   `musicSwitch` reads values); `atLeast` and `below` need a numeric value. A parameter the event doesn't have, or a
 *   comparison that doesn't fit its kind, warns once and leaves the region to its `count`.
 * - A new run (a transition, a playlist step, a seek, a reload or a recovery) starts with fresh state.
 *
 * Not built: a stem that changes file at E (a streamed alternative picked per pass) would move the commit point back
 * by a full prime lead; alternatives are picked once per run today, so no stem does.
 */
import type { RegionCondition, SegmentNode } from "../../../../engine/audio/musicFormat";
import { warnOnce } from "../core/handle";
import type { MusicFrame, MusicPlayer } from "./musicSystem";
import { anchorPastRegion, bindRelease, nextWrapOf } from "./anchors";
import { frameIntervalSeconds, lookaheadSeconds } from "./planner";
import type { SegmentRun } from "./segmentRun";

/** The splice margin (architecture §3.5): 480 frames at 48 kHz cover the ≥ 368 a splice needs ahead of the voice. */
export const WHILE_SPLICE_MARGIN_SECONDS = 0.01;
/** Float noise allowed when comparing heard seconds (far under one frame at 192 kHz). */
const EPS = 1e-7;

/** The playing segment's region state. R4b may add fields here. */
export interface RegionState {
  /** Index of the region the playhead is in, -1 outside any. R4b: the region of the next wrap (or the released one). */
  region: number;
  /** Passes done in that region. */
  passes: number;
  /** Heard time (seconds) of the next commit point (one lead before the loop end); NaN: none. */
  commitAt: number;
  /** The region was released (plays on past its end). */
  released: boolean;
  /** R4b: the released region's last pass (it ends at `releaseAt` and plays through); NaN while none is released. */
  lastPass: number;
  /** R4b: heard time (seconds) of the released region's end; NaN while none is released. */
  releaseAt: number;
  /** R4b: heard time of the wrap whose condition was read (or skipped as late); NaN: none yet. */
  decided: number;
  /** R4b: the run this state is for (a new run starts fresh). */
  run: SegmentRun | null;
  /** R4b: conditions read, releases committed, and commit points missed (a stall: one more pass). */
  reads: number;
  releases: number;
  late: number;
}

/** R4b: a region state for a new run. */
export function createRegionState(): RegionState {
  return {
    region: -1, passes: 0, commitAt: Number.NaN, released: false,
    lastPass: Number.NaN, releaseAt: Number.NaN, decided: Number.NaN, run: null, reads: 0, releases: 0, late: 0,
  };
}

/**
 * R4b: whether `cond` holds for the parameter value `value`; null when it can't be read (no such parameter, or the
 * comparison doesn't fit the value's kind).
 */
export function conditionHolds(cond: RegionCondition, value: number | string | undefined): boolean | null {
  if (value === undefined) return null;
  if ("is" in cond) return String(value) === cond.is;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return "atLeast" in cond ? value >= cond.atLeast : value < cond.below;
}

const sameTime = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** R4b, step 9: at a `while` region's commit point, read the condition; false releases the region. */
export function tickRegions(player: MusicPlayer, f: MusicFrame): void {
  const run = player.run;
  if (!run) return;
  let rs = player.regions;
  if (!rs || rs.run !== run) {
    rs = player.regions = createRegionState();
    rs.run = run;
  }
  if (run.state !== "stamped" && run.state !== "playing") return;
  if (player.state === "stopping" || player.state === "stopped" || player.state === "refused") return;
  const now = f.now;

  if (rs.released) {
    // Released: once its end has been heard the anchor moves past it and the next region is read afresh.
    if (now + EPS >= rs.releaseAt && anchorPastRegion(player, rs.region, rs.releaseAt, now)) {
      if (player.anchor) bindRelease(player.anchor, null);
      rs.released = false;
      rs.region = -1;
      rs.passes = 0;
      rs.lastPass = Number.NaN;
      rs.releaseAt = Number.NaN;
    }
    return;
  }

  const next = nextWrapOf(player, now);
  const wrap = next.at;
  const reg = Number.isFinite(wrap) && next.node === run.node ? (run.node as Partial<SegmentNode>).regions?.[next.region] : undefined;
  if (!reg || !reg.while) {
    rs.commitAt = Number.NaN;
    if (Number.isFinite(wrap)) {
      rs.region = next.region;
      rs.passes = next.pass - 1;
    }
    return;
  }
  rs.region = next.region;
  rs.passes = next.pass - 1;
  const lookahead = lookaheadSeconds(f);
  rs.commitAt = wrap - lookahead - frameIntervalSeconds(f) - WHILE_SPLICE_MARGIN_SECONDS;
  if (now + EPS < rs.commitAt || sameTime(rs.decided, wrap)) return;
  rs.decided = wrap;
  if (wrap - now < lookahead - EPS) {
    // A stall over the commit point: this wrap happens; the condition is read at the next one.
    rs.late++;
    return;
  }
  const value = player.instance.getParameter(reg.while.parameter);
  const holds = conditionHolds(reg.while, value);
  rs.reads++;
  if (holds === null) {
    warnOnce(
      `music:while:${player.instance.path}:${run.node.id}:${reg.id}`,
      value === undefined
        ? `Music "${player.instance.path}": segment "${run.node.id}" region "${reg.id}" loops while "${reg.while.parameter}", which the event has no parameter for; the region loops by its count.`
        : `Music "${player.instance.path}": segment "${run.node.id}" region "${reg.id}" compares "${reg.while.parameter}" (${JSON.stringify(value)}) as a number; the region loops by its count.`,
    );
    return;
  }
  if (holds) return;
  // Release: pass `next.pass` is the last; it ends at `wrap` and the segment plays on past the region.
  rs.released = true;
  rs.lastPass = next.pass;
  rs.releaseAt = wrap;
  rs.releases++;
  if (player.anchor) bindRelease(player.anchor, rs);
}
