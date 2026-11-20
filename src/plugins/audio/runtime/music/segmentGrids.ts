/**
 * The grid of a segment node now (ADR 0263): the one place the music runtime compiles a segment's grid
 * (`compileSegmentGrid`, G1) and its loop regions, and the one rule for how long the segment's file is.
 *
 * **Length rule.** A segment's file is its **first track that names a clip**. Its length is that clip's facts
 * (`SegmentClipSource.facts`: frames at the clip's own rate), else the backend's decoded length
 * (`clipCache.clipDuration`, seconds: a decoded clip ends at its buffer's end), else unknown.
 *
 * **Refresh.** Every read looks the length up (two map lookups) and recompiles when it differs from the one the cached
 * grid was compiled with, so a grid compiled before the clip was probed (no end: an `"end"` exit or cue unresolved)
 * becomes the full grid on the first read after the facts arrive. The cache is per node object (a reload swaps nodes),
 * private to this module; callers keep none.
 *
 * A node that isn't a segment, or has no tempo list, has no grid (null). A segment without a `cues` list compiles with
 * none.
 */
import { audioBackend } from "../backend";
import type { MusicNode, SegmentNode } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid, positionTextToTicks, ticksToSeconds, type SegmentGrid } from "../../../../engine/audio/musicGrid";
import { segmentClipSource } from "./segmentRun";

/**
 * The clip rate when the file's own rate is unknown (decoded-length only, or nothing known). This module sits in an
 * import cycle with `segmentRun.ts` and `anchors.ts`: importers read it inside functions, never at module load.
 */
export const FALLBACK_CLIP_RATE = 48_000;
/** Float noise allowed when comparing file seconds (far under one frame at 192 kHz). */
const EPS = 1e-9;
/**
 * Where an open-ended `segmentLoops` puts an `"end"` bound while the file's length is unknown (F-23): far past any real
 * file (about 116 days), so a region to the file's end is still a region and its first wrap is still ahead.
 */
const OPEN_END_SECONDS = 1e7;

/** A segment file's length by the length rule. */
export interface SegmentLength {
  /** Seconds of the file. */
  readonly seconds: number;
  /** Frames at `rate`, when the clip's facts are known; undefined for a decoded length (seconds only). */
  readonly frames: number | undefined;
  /** The clip's own rate (Hz), when its facts are known. */
  readonly rate: number | undefined;
}

/** A loop region in file seconds on the clip's frame grid (what the worker loops). */
export interface LoopRegion {
  /** Index in the segment's `regions`. */
  readonly index: number;
  readonly from: number;
  readonly to: number;
  /** Passes in all (0: forever). */
  readonly count: number;
}

/** A segment's grid with its usable loop regions on the frame grid of `rate`. */
export interface SegmentLoops {
  readonly grid: SegmentGrid;
  /** Usable regions (bounds that are positions, non-empty, before the exit), sorted by `from`. */
  readonly regions: readonly LoopRegion[];
  /** File seconds of the exit, +Infinity while unknown. */
  readonly exit: number;
  /** The rate (Hz) region bounds were rounded to frames of. */
  readonly rate: number;
}

interface Entry {
  /** The length the grid was compiled with (NaN: unknown). */
  readonly seconds: number;
  readonly grid: SegmentGrid;
  /** The loops of the last rate asked for. */
  loops: SegmentLoops | null;
}

const entries = new WeakMap<object, Entry>();

/** The clip the length rule reads: the first track that names one. */
function lengthClip(node: SegmentNode): string | undefined {
  if (!Array.isArray(node.tracks)) return undefined;
  for (const t of node.tracks) if (t.clip) return t.clip;
  return undefined;
}

/** The segment's file length by the length rule; undefined while unknown, or for a node that isn't a segment. */
export function segmentLength(node: MusicNode): SegmentLength | undefined {
  if (node.type !== "segment") return undefined;
  const clip = lengthClip(node);
  if (!clip) return undefined;
  const f = segmentClipSource().facts(clip);
  if (f && f.rate > 0) return { seconds: f.frames / f.rate, frames: f.frames, rate: f.rate };
  let d: number | null | undefined;
  try {
    d = audioBackend().clipCache?.clipDuration(clip);
  } catch {
    d = undefined; // no backend yet
  }
  return typeof d === "number" && d > 0 ? { seconds: d, frames: undefined, rate: undefined } : undefined;
}

/** Seconds of the length, NaN while unknown (without allocating for the comparison). */
function lengthSeconds(node: SegmentNode): number {
  return segmentLength(node)?.seconds ?? Number.NaN;
}

const sameSeconds = (a: number, b: number): boolean => a === b || (Number.isNaN(a) && Number.isNaN(b));

function compileEntry(node: SegmentNode, seconds: number): Entry {
  const seg = Array.isArray(node.cues) ? node : { ...node, cues: [] };
  const grid = compileSegmentGrid(seg, Number.isFinite(seconds) ? { endSeconds: seconds } : {});
  return { seconds, grid, loops: null };
}

function entryOf(node: MusicNode): Entry | null {
  if (node.type !== "segment" || !Array.isArray(node.tempo)) return null;
  const seconds = lengthSeconds(node);
  const cached = entries.get(node);
  if (cached && sameSeconds(cached.seconds, seconds)) return cached;
  const e = compileEntry(node, seconds);
  entries.set(node, e);
  return e;
}

/** The segment's grid now: with its file's end once the length is known. Null for a node without a grid. */
export function segmentGrid(node: MusicNode): SegmentGrid | null {
  return entryOf(node)?.grid ?? null;
}

/**
 * The segment's grid and loop regions, bounds in frames of `rate` (default: the clip's own rate, else 48 kHz). With
 * `openEnd` and the length unknown, an `"end"` bound is `OPEN_END_SECONDS` instead of dropping its region (F-23: which
 * region wraps first doesn't depend on where the file ends); that answer is provisional and not kept.
 */
export function segmentLoops(node: MusicNode, rate?: number, openEnd = false): SegmentLoops | null {
  const e = entryOf(node);
  if (!e || node.type !== "segment") return null;
  const len = Number.isFinite(e.seconds) ? segmentLength(node) : undefined;
  const provisional = openEnd && !len;
  const r = rate ?? len?.rate ?? FALLBACK_CLIP_RATE;
  if (!provisional && e.loops && e.loops.rate === r) return e.loops;
  const grid = e.grid;
  const exitT = grid.exitTicks;
  const exit = Number.isFinite(exitT) ? ticksToSeconds(grid, exitT) : Number.POSITIVE_INFINITY;
  // Region bounds in frames of `r` (what the worker loops); the end of a file known only in seconds stays exact.
  const frameOf = (text: string): number => {
    if (text === "start") return 0;
    if (text === "end") {
      if (!len) return provisional ? Math.round(OPEN_END_SECONDS * r) : Number.NaN;
      return len.frames !== undefined && len.rate !== undefined ? Math.round(len.frames * (r / len.rate)) : len.seconds * r;
    }
    const t = positionTextToTicks(grid, text);
    return t === null ? Number.NaN : Math.round(ticksToSeconds(grid, t) * r);
  };
  const regions: LoopRegion[] = [];
  (Array.isArray(node.regions) ? node.regions : []).forEach((reg, index) => {
    const a = frameOf(reg.from), b = frameOf(reg.to);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || a / r >= exit - EPS) return;
    regions.push({ index, from: a / r, to: b / r, count: Math.max(0, reg.count | 0) });
  });
  regions.sort((x, y) => x.from - y.from);
  const loops: SegmentLoops = { grid, regions, exit, rate: r };
  if (!provisional) e.loops = loops;
  return loops;
}
