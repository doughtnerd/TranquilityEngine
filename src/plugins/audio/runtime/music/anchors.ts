/**
 * The heard position (ADR 0166 api-and-models §3.2 `GridAnchor`; architecture §4.5 "Model", §3.5, §3.6, §3.7 rate change;
 * ADR 0285): the one module that maps between heard time and file position on a playing segment.
 *
 * Owner: **P3** (W4). Q2 wrote the skeleton.
 *
 * An anchor is integer ticks from the segment's bar 1 beat 1 **plus** the heard time it is at, never raw audio frames,
 * so a context rebuild at a new rate recomputes frames through the clock map. Heard time of position p =
 * t0 + sec(p) - sec(p0) within one pass; a loop pass adds the region's length; a committed successor has its own anchor
 * (P3 keeps its run's `startAt` slipped, so `anchorRun(next, next.startAt)` is right when R3a promotes it). Late starts,
 * holds and abandons shift t0 by their slip (any size; indices never re-fire).
 *
 * **Loop regions.** The worker loops a region in file frames (`loopStartFrame..loopEndFrame`, `MusicGroupMember`), so
 * a pass lasts exactly `(round(sec(to) x r) - round(sec(from) x r)) / r` heard seconds at pitch 1, r the clip's own rate
 * (the stems' clip facts, else 48 kHz as `stems.ts`): independent of the context's rate. Regions play in file order:
 * the playhead enters a region at its `from` (pass 1), wraps back to `from` at its `to` until it has played `count`
 * passes (0: forever; 1: no wrap, `musicValidate`'s `isLooping`), then plays on. A `while` region is capped by its
 * `count` and stops wrapping once R4b marks it released (`RegionState.released`): with the release's last pass
 * (`RegionState.lastPass`, what `tickRegions` sets) the wraps after that pass never happen, before or after `now`, in
 * every query (a bare anchor finds the release through `bindRelease`); without one (a bare `released`) only the wraps
 * after the asked time are dropped. Regions at or past the exit cue are never reached.
 *
 * **Whole questions.** Every query walks the passes from the anchor itself (a forever loop in closed form), so nothing
 * moves the anchor to "the pass heard now" first and no caller sums `anchor.time + (file - anchorFile)`:
 * - `ticksAt(anchor, T)`: the position heard at T;
 * - `nextHeard(position, T, next)` (`nextGridHeard` for a grid spec): the heard time of the first file position `next`
 *   names at or after the position heard at T, in the pass it is heard in (a point the loop wraps before is asked
 *   again from the region's start, one pass later; a point no pass reaches is NaN);
 * - `predictWrap`, `nextWrapOf`: the next wrap after T.
 * A point within half a clip frame before a wrap is the wrap's own (the next pass's first): the worker wraps on the
 * clip's frame grid, so the region's end line can be heard up to half a frame before the wrap.
 */
import type { MusicGroupEvent } from "../backend";
import type { MusicNode } from "../../../../engine/audio/musicFormat";
import { nextGridSeconds, positionTextToTicks, secondsToTicks, ticksToSeconds, type SegmentGrid } from "../../../../engine/audio/musicGrid";
import type { GridSpec } from "../../../../engine/audio/musicTypes";
import type { MusicPlayer } from "./musicSystem";
import type { RegionState } from "./regions";
import type { SegmentRun } from "./segmentRun";
import { clipFacts } from "../clipResolver";
import { FALLBACK_CLIP_RATE, segmentGrid, segmentLoops, type LoopRegion, type SegmentLoops } from "./segmentGrids";

/** §3.2 `GridAnchor`. P3 added `node` and `rate` (the anchor needs its segment's grid; nothing else stores frames). */
export interface GridAnchor {
  /** Node id of the anchored segment. */
  readonly segment: string;
  /** Integer ticks from bar 1 beat 1 of the segment (§2.2's ticks per beat). */
  ticks: number;
  /** Heard time (seconds) the position `ticks` is at. */
  time: number;
  /** The loop pass the anchor is in, from 1 (1 outside any region). */
  pass: number;
  /** P3: the anchored segment node (its grid and regions). */
  readonly node: MusicNode;
  /** P3: the clip's own rate (Hz) the worker loops regions in (file frames): the first stem's facts, else 48 kHz. */
  readonly rate: number;
}

/** Float noise allowed when comparing heard or file seconds (far under one frame at 192 kHz). */
const EPS = 1e-9;

// --- Compiled segments -------------------------------------------------------------------------------------------------

/** The anchored segment's grid and regions in frames of the anchor's rate (`segmentGrids.ts`, ADR 0263). */
const compiledOf = (a: GridAnchor): SegmentLoops | null => segmentLoops(a.node, a.rate);

// --- R4b's release ------------------------------------------------------------------------------------------------------

/** The release a walk honours: a `regions` index of the node (-1 none) and its last pass (NaN: only the wraps after the asked time drop). */
const release = { region: -1, lastPass: Number.NaN };

/** Sets `release` from a region state (none when it isn't released). */
function readRelease(rs: RegionState | null | undefined): void {
  release.region = rs && rs.released ? rs.region : -1;
  release.lastPass = rs && rs.released ? rs.lastPass : Number.NaN;
}

/** The region state whose release an anchor plays under (`ticksAt`, which sees only the anchor). */
const anchorRegions = new WeakMap<GridAnchor, RegionState>();

/**
 * R4b: `ticksAt(anchor, …)` honours `regions`' release from now on (the release is read when asked, so clearing
 * `regions.released` ends it). `null` unbinds.
 */
export function bindRelease(anchor: GridAnchor, regions: RegionState | null): void {
  if (regions) anchorRegions.set(anchor, regions);
  else anchorRegions.delete(anchor);
}

/** A member's loop region in file frames of its clip's own rate (`MusicGroupMember.loopStartFrame`/`loopEndFrame`). */
export interface MemberLoop {
  /** File frame the loop starts at (`from`; `"start"` is 0). */
  readonly startFrame: number;
  /** File frame it wraps at, exclusive; 0 = the file's end (`to: "end"`). */
  readonly endFrame: number;
  /** True when the region is the whole file (`0..end`): a decoded voice's own loop flag covers it. */
  readonly wholeFile: boolean;
}

/**
 * R4a: a region of the node (`index` in its `regions`) in file frames of `rate`, rounded as the anchor's pass walk rounds them
 * (`"start"` 0, `"end"` 0 = the file's end); null when a bound isn't a position or the region is empty.
 */
export function regionFramesOf(node: MusicNode, index: number, rate: number): MemberLoop | null {
  const reg = node.type === "segment" ? node.regions?.[index] : undefined;
  const grid = reg ? segmentGrid(node) : null;
  if (!reg || !grid || !(rate > 0)) return null;
  const frameOf = (text: string): number => {
    if (text === "start" || text === "end") return 0;
    const t = positionTextToTicks(grid, text);
    return t === null ? Number.NaN : Math.round(ticksToSeconds(grid, t) * rate);
  };
  const start = frameOf(reg.from), end = frameOf(reg.to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || (end !== 0 && end <= start) || start < 0) return null;
  return { startFrame: start, endFrame: end, wholeFile: start === 0 && end === 0 };
}

/**
 * R4a: the loop the members of a run starting at file frame `startFrame` (frames of `rate`) run first: the region of
 * the first wrap ahead (a region they start in or reach later that has a wrap to come: `count` 0 or >= 2; a `while`
 * region loops by its `count` until R4b releases it). Null when no wrap is ahead. Later regions are set as the walk
 * reaches them (`loopTail.ts`).
 */
export function firstLoopOf(node: MusicNode, rate: number, startFrame: number): (MemberLoop & { region: number }) | null {
  // F-23: a run is admitted (and its PLAYs' loops decided) before its decoded clips are, so the file's length may be
  // unknown here: a region to `"end"` must still loop its members (`regionFramesOf` gives the end as 0, the file's end).
  const c = segmentLoops(node, undefined, true);
  if (!c || c.regions.length === 0 || !(rate > 0)) return null;
  const s = Math.max(0, startFrame) / rate;
  readRelease(null);
  const w = wrapAhead({ s, h: 0, region: -1, passes: 1 }, c, false, wrapScratch);
  if (w.k < 0) return null;
  const index = c.regions[w.k]!.index;
  const frames = regionFramesOf(node, index, rate);
  return frames ? { ...frames, region: index } : null;
}

/** R4a: `nextWrapOf`'s answer (one reused object). */
export interface NextWrap {
  /** Heard time (seconds) of the next wrap after `now`; NaN: none. */
  at: number;
  /** The wrapping region's index in the node's `regions`; -1: none. */
  region: number;
  /** The pass that wrap ends (1 for the region's first). */
  pass: number;
  /** The anchored segment node. */
  node: MusicNode | null;
}

const nextWrapScratch: NextWrap = { at: Number.NaN, region: -1, pass: 0, node: null };

/**
 * R4a: `predictWrap` with the region it wraps: the heard time of the playing run's next wrap after `now`, the region
 * (index in the node's `regions`) and the pass it ends. Honours R4b's `released`. Returns one reused object.
 */
export function nextWrapOf(player: MusicPlayer, now: number): NextWrap {
  const out = nextWrapScratch;
  out.at = Number.NaN;
  out.region = -1;
  out.pass = 0;
  out.node = null;
  const a = anchorOfPlaying(player);
  if (!a || !Number.isFinite(now)) return out;
  const c = compiledOf(a);
  if (!c || c.regions.length === 0) return out;
  readRelease(player.regions);
  const w = wrapAfter(a, c, Math.max(now, a.time - EPS));
  if (w.k < 0) return out;
  out.at = w.at;
  out.region = c.regions[w.k]!.index;
  out.pass = w.pass;
  out.node = a.node;
  return out;
}

/**
 * What the pass walk reads of a player: its anchor, its playing run and the region release. A `MusicPlayer` is one; the
 * beat clock asks with a source's anchor and, for the playing run, the player's release.
 */
export interface PlayingPosition {
  readonly anchor: GridAnchor | null;
  readonly run: SegmentRun | null;
  readonly regions: RegionState | null;
}

/** The clip rate of a run: its first stem's facts, else 48 kHz. */
function runRate(run: SegmentRun): number {
  for (const s of run.stems) {
    const f = clipFacts(s.clip);
    if (f && f.rate > 0) return f.rate;
  }
  return FALLBACK_CLIP_RATE;
}

// --- Anchors -----------------------------------------------------------------------------------------------------------

/**
 * P3: the anchor of a run stamped at `at` (heard seconds) from file frame `run.startFrame` (frames of the clip's own
 * rate, pre-entry included): the first integer tick at or after that frame, at the heard time it plays. A start inside
 * a loop region is that region's pass 1 (a seek into a `count` region restarts its count).
 */
export function anchorRun(run: SegmentRun, at: number): GridAnchor {
  const rate = runRate(run);
  const c = segmentLoops(run.node, rate);
  const file = run.startFrame / rate;
  if (!c) return { segment: run.node.id, ticks: 0, time: at, pass: 1, node: run.node, rate };
  const exact = secondsToTicks(c.grid, file);
  const near = Math.round(exact);
  const ticks = Math.abs(exact - near) < 1e-6 ? near : Math.ceil(exact);
  return { segment: run.node.id, ticks, time: at + (ticksToSeconds(c.grid, ticks) - file), pass: 1, node: run.node, rate };
}

/**
 * P3: the position (ticks, fractional) heard at `time` (seconds) on the anchor's segment, NaN when unknown. Loop passes
 * after the anchor are unrolled (a time three passes on reads the region's position, not past its end); before the
 * anchor it extrapolates linearly. A released `while` region is known through `bindRelease` (R4b binds the player's anchor).
 */
export function ticksAt(anchor: GridAnchor, time: number): number {
  const c = compiledOf(anchor);
  if (!c || !Number.isFinite(time) || !Number.isFinite(anchor.time)) return Number.NaN;
  const cur = cursorOf(anchor, c);
  readRelease(anchorRegions.get(anchor));
  if (time > anchor.time) walkTo(cur, c, time);
  return secondsToTicks(c.grid, cur.s + (time - cur.h));
}

/**
 * P3: the heard time (seconds) of the next wrap of the playing loop region after `now`, NaN when it doesn't loop
 * (no region ahead that wraps, its passes used up, released by R4b, or past the exit cue). The region may be one the
 * playhead hasn't reached yet (R4b's first commit point). R4a stamps tails at it; R4b's commit point is one lead before.
 */
export function predictWrap(player: PlayingPosition, now: number): number {
  const a = anchorOfPlaying(player);
  if (!a || !Number.isFinite(now)) return Number.NaN;
  const c = compiledOf(a);
  if (!c || c.regions.length === 0) return Number.NaN;
  readRelease(player.regions);
  return wrapAfter(a, c, Math.max(now, a.time - EPS)).at;
}

/**
 * R4b: once a released region's last pass has been heard, move the player's anchor to that region's end (the first
 * integer tick at or after its `to`, at the heard time it plays, pass 1), so nothing needs the release after that.
 * `region` is an index in the node's `regions`, `releaseAt` the heard time of the region's end. False when the anchor
 * isn't on a segment with that region, or that time isn't reached by `now` yet.
 */
export function anchorPastRegion(player: MusicPlayer, region: number, releaseAt: number, now: number): boolean {
  const a = player.anchor;
  const c = a ? compiledOf(a) : null;
  const r = c?.regions.find((x) => x.index === region);
  if (!a || !c || !r || !Number.isFinite(releaseAt)) return false;
  const exact = secondsToTicks(c.grid, r.to);
  const near = Math.round(exact);
  const ticks = Math.abs(exact - near) < 1e-6 ? near : Math.ceil(exact);
  const time = releaseAt + (ticksToSeconds(c.grid, ticks) - r.to);
  if (!(now >= time)) return false;
  a.ticks = ticks;
  a.time = time;
  a.pass = 1;
  return true;
}

/** The anchor of the playing run: the player's when it is for that run's segment, else one from the run's stamp. */
function anchorOfPlaying(player: PlayingPosition): GridAnchor | null {
  const a = player.anchor;
  const run = player.run;
  if (a && (!run || a.segment === run.node.id)) return a;
  if (run && Number.isFinite(run.startAt)) return anchorRun(run, run.startAt);
  return null;
}

// --- Corrections (architecture §3.6, §4.3, §4.5) -----------------------------------------------------------------------

/**
 * P3: a late start, hold or abandon of the player's group shifts its anchor by the slip (architecture §4.5
 * "Corrections"). The run's `startAt` moves too (a successor's anchor is made from it), and the counters count it:
 * a late `start` in `lateGroups`, a `resume` in `groupsHeld` (its slip is the hold), an `abandon` in `groupTimeouts`
 * (no shift: the core ended the members and the planner re-plans). `sampleRate` is the context's rate the slip is in.
 *
 * `heardStart` (a `start` only): the heard time of the event's `startFrame` (`startFrame / sr + timeOffset`, the
 * clock map's), when the caller knows it. Then t0 = f0 / sr exactly (architecture §4.5), which also takes out the stamp's
 * rounding to a frame (up to half a frame); it is used only when it agrees with the slip within one frame.
 */
export function applySlip(
  player: MusicPlayer, e: Extract<MusicGroupEvent, { slipFrames: number }>, sampleRate: number, heardStart?: number,
): void {
  const c = player.counters;
  if (e.kind === "abandon") {
    c.groupTimeouts++;
    return;
  }
  if (e.kind === "resume") c.groupsHeld++;
  else if (e.late) c.lateGroups++;
  if (!(sampleRate > 0)) return;
  const run = player.run?.group === e.group ? player.run : player.next?.group === e.group ? player.next : null;
  let dt = e.slipFrames / sampleRate;
  if (e.kind === "start" && run && heardStart !== undefined && Number.isFinite(heardStart) && Number.isFinite(run.startAt)) {
    const exact = heardStart - run.startAt;
    if (Math.abs(exact - dt) <= 1 / sampleRate) dt = exact;
  }
  if (e.slipFrames !== 0) {
    c.lastSlipFrames = e.slipFrames;
    counterRate.set(player, sampleRate);
  }
  if (!run || dt === 0) return;
  if (Number.isFinite(run.startAt)) run.startAt += dt;
  const a = player.anchor;
  if (a && run === player.run && a.segment === run.node.id) a.time += dt;
}

/** Context rate each player's frame counters are in (`rebaseAnchors` rescales `lastSlipFrames`). */
const counterRate = new WeakMap<MusicPlayer, number>();

/**
 * P3: a context rebuilt at a new rate: anchors keep their musical position and heard time (within 1 frame). The anchor,
 * the runs' `startAt` and region lengths are heard or file seconds, so nothing moves: `Audio.time` continues across the
 * swap (`ClockMap.rebase`) and every frame is recomputed from them at the new rate (`clockMap.frameOfTime`). Only
 * `counters.lastSlipFrames`, kept in context frames, is rescaled to the new rate.
 */
export function rebaseAnchors(player: MusicPlayer, sampleRate: number): void {
  if (!(sampleRate > 0)) return;
  const old = counterRate.get(player);
  if (old !== undefined && old !== sampleRate) {
    player.counters.lastSlipFrames = Math.round((player.counters.lastSlipFrames * sampleRate) / old);
  }
  counterRate.set(player, sampleRate);
  if (player.anchor) compiledOf(player.anchor); // the grid stays cached; nothing else holds frames
}

// --- The pass walk -------------------------------------------------------------------------------------------------------

/** Where the playhead is: file seconds `s` heard at `h`, in region `region` (an index in `regions`, -1 none) pass `passes`. */
interface Cursor {
  s: number;
  h: number;
  region: number;
  passes: number;
}

/**
 * The wrap the playhead meets next (`wrapAhead`): its region (an index in `regions`, -1: none ahead), the pass it ends,
 * the wraps left in the region from there (that one included), and its heard time.
 */
interface Wrap {
  k: number;
  pass: number;
  left: number;
  at: number;
}

const wrapScratch: Wrap = { k: -1, pass: 0, left: 0, at: Number.NaN };

function regionAt(c: SegmentLoops, s: number): LoopRegion | null {
  for (const r of c.regions) if (r.from <= s + EPS && s < r.to - EPS) return r;
  return null;
}

function cursorOf(a: GridAnchor, c: SegmentLoops): Cursor {
  const s = ticksToSeconds(c.grid, a.ticks);
  const r = regionAt(c, s);
  return { s, h: a.time, region: r ? c.regions.indexOf(r) : -1, passes: r ? Math.max(1, a.pass) : 1 };
}

/**
 * The first wrap the playhead meets from `cur` playing on (regions without wraps left are played through), into `out`.
 * The released region (`release`) wraps for the last time at the end of pass `lastPass - 1` (R4b: pass `lastPass` plays
 * through); a bare release (`lastPass` NaN) has no wraps left when `dropBare` (the wraps after the asked time don't happen).
 */
function wrapAhead(cur: Cursor, c: SegmentLoops, dropBare: boolean, out: Wrap): Wrap {
  out.k = -1;
  out.at = Number.NaN;
  let s = cur.s;
  let h = cur.h;
  const regions = c.regions;
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i]!;
    if (s >= r.to - EPS) continue; // behind the playhead
    if (s >= c.exit - EPS) break; // past the exit: never reached
    const passes = r.from <= s + EPS && cur.region === i ? cur.passes : 1;
    let left = r.count === 0 ? Number.POSITIVE_INFINITY : r.count - passes;
    if (r.index === release.region) {
      if (release.lastPass === release.lastPass) left = Math.min(left, Math.max(0, release.lastPass - passes));
      else if (dropBare) left = 0;
    }
    if (left > 0) {
      out.k = i;
      out.pass = passes;
      out.left = left;
      out.at = h + (r.to - s);
      return out;
    }
    h += r.to - s; // no wraps left: it plays through
    s = r.to;
  }
  return out;
}

/**
 * Takes every wrap heard at or before `limit` (in closed form: a forever loop may have run for hours), moving the cursor
 * to the last one. A wrap within float noise after `limit` counts as at it, so a wrap time another query reported (a sum
 * in another order) is taken when asked for.
 */
function walkTo(cur: Cursor, c: SegmentLoops, at: number): void {
  const limit = at + EPS;
  for (let guard = 0; guard < 2 * c.regions.length + 2; guard++) {
    const w = wrapAhead(cur, c, false, wrapScratch);
    if (w.k < 0 || !(w.at <= limit)) return;
    const r = c.regions[w.k]!;
    const len = r.to - r.from;
    let n = Math.floor((limit - w.at) / len) + 1;
    if (w.at + n * len <= limit) n++;
    while (n > 1 && w.at + (n - 1) * len > limit) n--;
    n = Math.min(n, w.left);
    cur.h = w.at + (n - 1) * len;
    cur.s = r.from;
    cur.region = w.k;
    cur.passes = w.pass + n;
  }
}

/** The first wrap of anchor `a` heard after `limit` (`release` read already); a bare release's wraps after `limit` are dropped. */
function wrapAfter(a: GridAnchor, c: SegmentLoops, limit: number): Wrap {
  const cur = cursorOf(a, c);
  walkTo(cur, c, limit);
  return wrapAhead(cur, c, true, wrapScratch);
}

// --- Whole questions ---------------------------------------------------------------------------------------------------

/**
 * A file position a query wants (`nextHeard`): the first one at or after file seconds `file` on `grid` (strictly after
 * it when `strict`), NaN when there is none. Pure: the walk may ask more than once.
 */
export type NextPoint = (grid: SegmentGrid, file: number, strict: boolean) => number;

/** `nextHeard`'s answer (one reused object): the point's heard time and file seconds, both NaN when there is none. */
export interface HeardPoint {
  at: number;
  file: number;
}

const heardScratch: HeardPoint = { at: Number.NaN, file: Number.NaN };

/** Heard seconds a strict query's point must be after the asked time. */
const STRICT_EPS = 1e-7;

const isAnchor = (x: PlayingPosition | GridAnchor): x is GridAnchor => "segment" in x;

/**
 * ADR 0285: the heard time of the first file position `next` names at or after the position heard at `after` (strictly
 * after `after` when `strict`), in the pass it is heard in. A point the playing loop wraps before (or within half a clip
 * frame of the wrap) is asked again from the region's start, one pass later; when no pass of the region holds one, the
 * walk goes on past the region's last wrap, and a region looping forever gives NaN. Nothing before the anchor is asked:
 * the search starts no earlier than `anchor.time`. `position` is a playing position (its run's anchor, the release of its
 * `regions`) or a bare anchor (its release through `bindRelease`). Returns one reused object: read it, don't keep it.
 */
export function nextHeard(position: PlayingPosition | GridAnchor, after: number, next: NextPoint, strict = false): HeardPoint {
  const out = heardScratch;
  out.at = Number.NaN;
  out.file = Number.NaN;
  const pos = isAnchor(position) ? null : position;
  const a = pos ? anchorOfPlaying(pos) : (position as GridAnchor);
  if (!a || !Number.isFinite(after) || !Number.isFinite(a.time)) return out;
  const c = compiledOf(a);
  if (!c) return out;
  readRelease(pos?.regions ?? anchorRegions.get(a));
  const from = Math.max(after, a.time);
  const cur = cursorOf(a, c);
  walkTo(cur, c, from);
  cur.s += from - cur.h; // no wrap between the cursor and `from`
  cur.h = from;
  const half = 0.5 / a.rate + EPS;
  const g = c.grid;
  for (let guard = 0; guard < 2 * c.regions.length + 4; guard++) {
    const w = wrapAhead(cur, c, true, wrapScratch);
    let p = next(g, cur.s, false);
    let h = cur.h + (p - cur.s);
    if (guard === 0 && strict && Number.isFinite(p) && !(h > after + STRICT_EPS)) {
      p = next(g, p, true);
      h = cur.h + (p - cur.s);
    }
    if (Number.isFinite(p) && (w.k < 0 || h < w.at - half)) {
      out.at = h;
      out.file = p;
      return out;
    }
    if (w.k < 0) return out;
    // The pass wraps first: on from the region's start, one pass later; past its last wrap when no pass of it holds a point.
    const r = c.regions[w.k]!;
    const len = r.to - r.from;
    const q = next(g, r.from, false);
    const n = Number.isFinite(q) && q - r.from < len - half ? 1 : w.left;
    if (!Number.isFinite(n)) return out; // a forever loop that never plays the point
    cur.h = w.at + (n - 1) * len;
    cur.s = r.from;
    cur.region = w.k;
    cur.passes = w.pass + n;
  }
  return out;
}

let gridSpec: GridSpec = "bar";
const nextGridPoint: NextPoint = (g, file, strict) =>
  nextGridSeconds(g, strict ? ticksToSeconds(g, Math.round(secondsToTicks(g, file)) + 1) : file, gridSpec);

/** ADR 0285: `nextHeard` for the grid points of `spec` (strict: the one after the point on the tick heard at `after`). */
export function nextGridHeard(position: PlayingPosition | GridAnchor, after: number, spec: GridSpec, strict = false): HeardPoint {
  gridSpec = spec;
  return nextHeard(position, after, nextGridPoint, strict);
}
