/**
 * Grid anchors, counted loop regions and wrap prediction (ADR 0166 api-and-models §3.2 `GridAnchor`; architecture §4.5
 * "Model", §3.5, §3.6, §3.7 rate change).
 *
 * Owner: **P3** (W4). Q2 wrote the skeleton.
 *
 * An anchor is integer ticks from the segment's bar 1 beat 1 **plus** the heard time it is at, never raw audio frames,
 * so a context rebuild at a new rate recomputes frames through the clock map. Heard time of position p =
 * t0 + sec(p) - sec(p0) (R1's `heardTimeAt`, the one definition); a loop pass adds k x the region length; a committed
 * successor has its own anchor (P3 keeps its run's `startAt` slipped, so `anchorRun(next, next.startAt)` is right when
 * R3a promotes it). Late starts, holds and abandons shift t0 by their slip (any size; indices never re-fire).
 *
 * **Loop regions.** The worker loops a region in file frames (`loopStartFrame..loopEndFrame`, `MusicGroupMember`), so
 * a pass lasts exactly `(round(sec(to) x r) - round(sec(from) x r)) / r` heard seconds at pitch 1, r the clip's own rate
 * (the stems' clip facts, else 48 kHz as `stems.ts`): independent of the context's rate. Regions play in file order:
 * the playhead enters a region at its `from` (pass 1), wraps back to `from` at its `to` until it has played `count`
 * passes (0: forever; 1: no wrap, `musicValidate`'s `isLooping`), then plays on. A `while` region is capped by its
 * `count` and stops wrapping once R4b marks it released (`RegionState.released`); `predictWrap` honours that for wraps
 * after `now`, `ticksAt` (which sees only the anchor) doesn't. Regions at or past the exit cue are never reached.
 *
 * **Re-anchoring.** Nothing here needs it (every query unrolls the passes from the anchor), but readers that apply
 * heard(t) = t0 + file(t) - file(p0) linearly (the planner's `defaultPoint`, R1's `PlayingGrid`, R6's `nextGridHeard`)
 * are right only within the anchor's pass: `advanceAnchor(player, now)` moves the anchor to the pass heard at `now`.
 */
import { audioBackend, type MusicGroupEvent } from "../backend";
import type { SegmentNode } from "../../../../engine/audio/musicFormat";
import {
  compileSegmentGrid, positionTextToTicks, secondsToTicks, ticksToSeconds, type SegmentGrid,
} from "../../../../engine/audio/musicGrid";
import type { MusicNodeRef, MusicPlayer } from "./musicSystem";
import { segmentClipSource, type SegmentRun } from "./segmentRun";
import { heardTimeAt, type PlayingGrid } from "./transitionRules";

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
  readonly node: MusicNodeRef;
  /** P3: the clip's own rate (Hz) the worker loops regions in (file frames): the first stem's facts, else 48 kHz. */
  readonly rate: number;
}

/** The clip rate when no stem has facts yet (as `stems.ts`). */
const FALLBACK_RATE = 48_000;
/** Float noise allowed when comparing heard or file seconds (far under one frame at 192 kHz). */
const EPS = 1e-9;

// --- Compiled segments -------------------------------------------------------------------------------------------------

/** A loop region in file seconds on the clip's frame grid (what the worker loops). */
interface LoopRegion {
  /** Index in the segment's `regions` (R4b's `RegionState.region`). */
  readonly index: number;
  readonly from: number;
  readonly to: number;
  /** Passes in all (0: forever). */
  readonly count: number;
}

interface Compiled {
  readonly grid: SegmentGrid;
  /** Usable regions, sorted by `from`. */
  readonly regions: readonly LoopRegion[];
  /** File seconds of the exit cue, +Infinity when unknown. */
  readonly exit: number;
  readonly rate: number;
  /** The grid knew the file's end (a later call recompiles once facts arrive). */
  readonly endKnown: boolean;
}

const compiled = new WeakMap<object, Compiled>();

/**
 * The file's length: the clip facts (frames at its own rate), else the backend's decoded length in seconds
 * (`clipDuration`: a decoded clip loops at its buffer's end, so the seconds are the pass length itself). Undefined
 * while neither is known.
 */
function factsOf(node: MusicNodeRef): { frames: number; rate: number } | { seconds: number } | undefined {
  const clip = (node as Partial<SegmentNode>).tracks?.find((t) => t.clip)?.clip;
  if (!clip) return undefined;
  const f = segmentClipSource().facts(clip);
  if (f && f.rate > 0) return f;
  let d: number | null | undefined;
  try {
    d = audioBackend().clipDuration?.(clip);
  } catch {
    d = undefined;
  }
  return typeof d === "number" && d > 0 ? { seconds: d } : undefined;
}

const endSecondsOf = (f: { frames: number; rate: number } | { seconds: number }): number =>
  "seconds" in f ? f.seconds : f.frames / f.rate;

/** The segment's grid and loop regions, cached per node object (recompiled once when the clip's facts arrive). */
function compile(node: MusicNodeRef, rate?: number): Compiled | null {
  const cached = compiled.get(node);
  const facts = factsOf(node);
  if (cached && (cached.endKnown || !facts) && (rate === undefined || cached.rate === rate)) return cached;
  const seg = node as Partial<SegmentNode>;
  if (node.type !== "segment" || !Array.isArray(seg.tempo)) return null;
  const r = rate ?? (facts && "rate" in facts ? facts.rate : FALLBACK_RATE);
  const endSeconds = facts ? endSecondsOf(facts) : Number.NaN;
  const grid = compileSegmentGrid({ ...seg, cues: seg.cues ?? [] } as SegmentNode, facts ? { endSeconds } : {});
  const exitT = grid.exitTicks;
  const exit = Number.isFinite(exitT) ? ticksToSeconds(grid, exitT) : Number.POSITIVE_INFINITY;
  // Region bounds in frames of `r` (what the worker loops); the end of a file known only in seconds stays exact.
  const frameOf = (text: string): number => {
    if (text === "start") return 0;
    if (text === "end") {
      if (!facts) return Number.NaN;
      return "rate" in facts ? Math.round(facts.frames * (r / facts.rate)) : endSeconds * r;
    }
    const t = positionTextToTicks(grid, text);
    return t === null ? Number.NaN : Math.round(ticksToSeconds(grid, t) * r);
  };
  const regions: LoopRegion[] = [];
  (seg.regions ?? []).forEach((reg, index) => {
    const a = frameOf(reg.from), b = frameOf(reg.to);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || a / r >= exit - EPS) return;
    regions.push({ index, from: a / r, to: b / r, count: Math.max(0, reg.count | 0) });
  });
  regions.sort((x, y) => x.from - y.from);
  const c: Compiled = { grid, regions, exit, rate: r, endKnown: facts !== undefined };
  compiled.set(node, c);
  return c;
}

const compiledOf = (a: GridAnchor): Compiled | null => compile(a.node, a.rate);

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
 * P3: the loop of a segment the worker (or a decoded voice) runs by itself: **exactly one region with `count: 0` and
 * no `while`** (the simple forever loop). Counted passes, `while` and several regions are R4a/R4b's: null. Frames are
 * at the clip's own `rate`, rounded as the anchor's pass walk rounds them (`compile`), so `predictWrap` and the grid
 * agree with the looping member; null too when a bound isn't a position or the region is empty.
 */
export function simpleLoopOf(node: MusicNodeRef, rate: number): MemberLoop | null {
  const regions = (node as Partial<SegmentNode>).regions;
  if (!Array.isArray(regions) || regions.length !== 1) return null;
  const reg = regions[0]!;
  if (reg.count !== 0 || reg.while !== undefined) return null;
  const c = compile(node);
  if (!c || !(rate > 0)) return null;
  const frameOf = (text: string): number => {
    if (text === "start") return 0;
    if (text === "end") return 0;
    const t = positionTextToTicks(c.grid, text);
    return t === null ? Number.NaN : Math.round(ticksToSeconds(c.grid, t) * rate);
  };
  const start = frameOf(reg.from), end = frameOf(reg.to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || (end !== 0 && end <= start) || start < 0) return null;
  return { startFrame: start, endFrame: end, wholeFile: start === 0 && end === 0 };
}

/** The clip rate of a run: its first stem's facts, else 48 kHz. */
function runRate(run: SegmentRun): number {
  for (const s of run.stems) {
    const f = segmentClipSource().facts(s.clip);
    if (f && f.rate > 0) return f.rate;
  }
  return FALLBACK_RATE;
}

// --- Anchors -----------------------------------------------------------------------------------------------------------

/**
 * P3: the anchor of a run stamped at `at` (heard seconds) from file frame `run.startFrame` (frames of the clip's own
 * rate, pre-entry included): the first integer tick at or after that frame, at the heard time it plays. A start inside
 * a loop region is that region's pass 1 (a seek into a `count` region restarts its count).
 */
export function anchorRun(run: SegmentRun, at: number): GridAnchor {
  const rate = runRate(run);
  const c = compile(run.node, rate);
  const file = run.startFrame / rate;
  if (!c) return { segment: run.node.id, ticks: 0, time: at, pass: 1, node: run.node, rate };
  const exact = secondsToTicks(c.grid, file);
  const near = Math.round(exact);
  const ticks = Math.abs(exact - near) < 1e-6 ? near : Math.ceil(exact);
  return { segment: run.node.id, ticks, time: at + (ticksToSeconds(c.grid, ticks) - file), pass: 1, node: run.node, rate };
}

/** One scratch `PlayingGrid` so heard time has R1's single definition without allocating per call. */
const scratch = { grid: null as unknown as SegmentGrid, anchorTicks: 0, anchorTime: 0 };

/** The anchor as R1's `PlayingGrid` (R3a's `exitTime`, `ticksAtHeard`): valid within the anchor's pass. Null without a grid. */
export function playingGridOf(anchor: GridAnchor): PlayingGrid | null {
  const c = compiledOf(anchor);
  return c ? { grid: c.grid, anchorTicks: anchor.ticks, anchorTime: anchor.time } : null;
}

/** P3: heard time (seconds) of the position `ticks` (on the anchor's segment, its pass), NaN when unknown. */
export function heardTimeOf(anchor: GridAnchor, ticks: number): number {
  const c = compiledOf(anchor);
  if (!c || !Number.isFinite(ticks) || !Number.isFinite(anchor.time)) return Number.NaN;
  scratch.grid = c.grid;
  scratch.anchorTicks = anchor.ticks;
  scratch.anchorTime = anchor.time;
  return heardTimeAt(scratch, ticks);
}

/**
 * P3: heard time of `ticks` in loop pass `pass` of the region the anchor is in (K1's beats in later passes): the
 * anchor's pass plus (pass - anchor.pass) region lengths. Outside a region only `pass === anchor.pass` is defined.
 */
export function heardTimeAtPass(anchor: GridAnchor, ticks: number, pass: number): number {
  const t = heardTimeOf(anchor, ticks);
  if (pass === anchor.pass) return t;
  const c = compiledOf(anchor);
  const r = c ? regionAt(c, ticksToSeconds(c.grid, anchor.ticks)) : null;
  return r ? t + (pass - anchor.pass) * (r.to - r.from) : Number.NaN;
}

/**
 * P3: the position (ticks, fractional) heard at `time` (seconds) on the anchor's segment, NaN when unknown. Loop passes
 * after the anchor are unrolled (a time three passes on reads the region's position, not past its end); before the
 * anchor it extrapolates linearly. A released `while` region isn't known here (re-anchor after the release).
 */
export function ticksAt(anchor: GridAnchor, time: number): number {
  const c = compiledOf(anchor);
  if (!c || !Number.isFinite(time) || !Number.isFinite(anchor.time)) return Number.NaN;
  const cur = cursorOf(anchor, c);
  if (time > anchor.time) advance(cur, c, time, -1);
  return secondsToTicks(c.grid, cur.s + (time - cur.h));
}

/**
 * P3: the heard time (seconds) of the next wrap of the playing loop region after `now`, NaN when it doesn't loop
 * (no region ahead that wraps, its passes used up, released by R4b, or past the exit cue). The region may be one the
 * playhead hasn't reached yet (R4b's first commit point). R4a stamps tails at it; R4b's commit point is one lead before.
 */
export function predictWrap(player: MusicPlayer, now: number): number {
  const a = anchorOfPlaying(player);
  if (!a || !Number.isFinite(now)) return Number.NaN;
  const c = compiledOf(a);
  if (!c || c.regions.length === 0) return Number.NaN;
  const rs = player.regions;
  const released = rs && rs.released ? rs.region : -1;
  const cur = cursorOf(a, c);
  return advance(cur, c, Math.max(now, a.time - EPS), released);
}

/**
 * P3: move the player's anchor to the loop pass heard at `now` (the last wrap at or before it): ticks at the region's
 * `from` (the first integer tick at or after it), the pass counted on. Returns true when it moved. Call it once per
 * frame before code that reads the anchor linearly (see the file header).
 */
export function advanceAnchor(player: MusicPlayer, now: number): boolean {
  const a = player.anchor;
  if (!a || !Number.isFinite(now) || !(now > a.time)) return false;
  const c = compiledOf(a);
  if (!c || c.regions.length === 0) return false;
  const cur = cursorOf(a, c);
  advance(cur, c, now, -1);
  if (!cur.wrapped) return false;
  const exact = secondsToTicks(c.grid, cur.wrapS);
  const near = Math.round(exact);
  const ticks = Math.abs(exact - near) < 1e-6 ? near : Math.ceil(exact);
  a.ticks = ticks;
  a.time = cur.wrapH + (ticksToSeconds(c.grid, ticks) - cur.wrapS);
  a.pass = cur.wrapPass;
  return true;
}

/** The anchor of the playing run: the player's when it is for that run's segment, else one from the run's stamp. */
function anchorOfPlaying(player: MusicPlayer): GridAnchor | null {
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
  /** At least one wrap was taken by `advance`. */
  wrapped: boolean;
  /** The last wrap taken: heard time, the file seconds it landed on (the region's `from`), the pass it began. */
  wrapH: number;
  wrapS: number;
  wrapPass: number;
}

function regionAt(c: Compiled, s: number): LoopRegion | null {
  for (const r of c.regions) if (r.from <= s + EPS && s < r.to - EPS) return r;
  return null;
}

function cursorOf(a: GridAnchor, c: Compiled): Cursor {
  const s = ticksToSeconds(c.grid, a.ticks);
  const r = regionAt(c, s);
  return {
    s, h: a.time, region: r ? c.regions.indexOf(r) : -1, passes: r ? Math.max(1, a.pass) : 1,
    wrapped: false, wrapH: Number.NaN, wrapS: Number.NaN, wrapPass: 1,
  };
}

/**
 * Takes every wrap heard at or before `limit` (moving the cursor to the last one) and returns the heard time of the
 * first wrap after `limit`, NaN when none. Wraps of region `released` (a `regions` index of the node) after `limit`
 * don't happen.
 */
function advance(cur: Cursor, c: Compiled, limit: number, released: number): number {
  const regions = c.regions;
  for (let guard = 0; guard < 4 * regions.length + 4; guard++) {
    // The region the playhead is in, or the next one it enters.
    let k = -1;
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i]!;
      if (r.from <= cur.s + EPS && cur.s < r.to - EPS) { k = i; break; }
      if (r.from > cur.s && (k < 0 || r.from < regions[k]!.from)) k = i;
    }
    if (k < 0) return Number.NaN;
    const r = regions[k]!;
    if (r.from > cur.s + EPS) {
      // Enter it at its `from`: pass 1.
      cur.h += r.from - cur.s;
      cur.s = r.from;
      cur.region = k;
      cur.passes = 1;
    } else if (cur.region !== k) {
      cur.region = k;
      cur.passes = 1;
    }
    const len = r.to - r.from;
    const left = r.count === 0 ? Number.POSITIVE_INFINITY : r.count - cur.passes; // wraps still to come
    const first = cur.h + (r.to - cur.s);
    if (left > 0) {
      if (first > limit) {
        if (r.index !== released) return first;
      } else {
        // Every wrap at or before `limit`, in closed form (a forever loop may have run for hours).
        let n = Math.floor((limit - first) / len) + 1;
        if (first + n * len <= limit) n++;
        while (n > 1 && first + (n - 1) * len > limit) n--;
        n = Math.min(n, left);
        cur.h = first + (n - 1) * len;
        cur.s = r.from;
        cur.passes += n;
        cur.wrapped = true;
        cur.wrapH = cur.h;
        cur.wrapS = cur.s;
        cur.wrapPass = cur.passes;
        if (n < left) {
          const next = cur.h + len;
          if (r.index !== released) return next;
        } else {
          continue; // passes used up: play through this pass, then on
        }
      }
    }
    // No (more) wraps here: play through to its end and look further on.
    cur.h += r.to - cur.s;
    cur.s = r.to;
    cur.region = -1;
    cur.passes = 1;
    if (cur.s >= c.exit - EPS) return Number.NaN;
  }
  return Number.NaN;
}
