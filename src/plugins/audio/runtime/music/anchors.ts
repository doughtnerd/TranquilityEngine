/**
 * The heard position of a looping voice (ADR 0285; first written for music segments, ADR 0166, and re-keyed on playlist
 * voices by ADR 0343): the one module that maps between heard time and file position for a playing sample that loops
 * regions of itself.
 *
 * An anchor is integer ticks from the grid's bar 1 beat 1 **plus** the heard time it is at, never raw audio frames, so
 * a context rebuild at a new rate recomputes frames through the clock map. Heard time of position p =
 * t0 + sec(p) - sec(p0) within one pass; a loop pass adds the region's length.
 *
 * **Loop regions.** The voice loops a region in file frames, so a pass lasts exactly
 * `(round(sec(to) x r) - round(sec(from) x r)) / r` heard seconds at pitch 1, r the clip's own rate: independent of the
 * context's rate. Regions play in file order: the playhead enters a region at its `from` (pass 1), wraps back to `from`
 * at its `to` until it has played `count` passes (0: forever; 1: no wrap), then plays on. Regions at or past the exit are
 * never reached. A voice whose loop stops wrapping is re-anchored where it is, with that region gone.
 *
 * **Whole questions.** Every query walks the passes from the anchor itself (a forever loop in closed form), so nothing
 * moves the anchor to "the pass heard now" first:
 * - `ticksAtOn(anchor, T)`: the position heard at T;
 * - `nextHeardOn(anchor, T, next)` (`nextGridHeardOn` for a grid spec): the heard time of the first file position `next`
 *   names at or after the position heard at T, in the pass it is heard in (a point the loop wraps before is asked again
 *   from the region's start, one pass later; a point no pass reaches is NaN).
 * A point within half a clip frame before a wrap is the wrap's own (the next pass's first): the voice wraps on the clip's
 * frame grid, so the region's end line can be heard up to half a frame before the wrap.
 */
import { nextGridSeconds, secondsToTicks, ticksToSeconds, type SegmentGrid } from "../../../../engine/audio/musicGrid";
import type { GridSpec } from "../../../../engine/audio/musicTypes";

/** One usable loop region of a voice, in file seconds on the frame grid of its rate. */
export interface LoopRegion {
  /** Index in the voice's own list of loops. */
  readonly index: number;
  readonly from: number;
  readonly to: number;
  /** Passes in all (0: forever). */
  readonly count: number;
}

/** A voice's grid with its usable loop regions on the frame grid of `rate`. */
export interface SegmentLoops {
  readonly grid: SegmentGrid;
  /** Usable regions (non-empty, before the exit), sorted by `from`. */
  readonly regions: readonly LoopRegion[];
  /** File seconds of the exit, +Infinity while unknown. */
  readonly exit: number;
  /** The rate (Hz) region bounds were rounded to frames of. */
  readonly rate: number;
}

/** What the pass walk reads of an anchor: a position in ticks heard at `time`, in loop pass `pass`, on a clip of `rate` Hz. */
interface AnchorPoint {
  readonly ticks: number;
  readonly time: number;
  readonly pass: number;
  readonly rate: number;
}

/**
 * ADR 0343: the heard position of a playing playlist voice: its grid (the sample's tempo map, ticks) and loop regions
 * (`loops`), so the pass walk answers for a sample that loops its own region.
 */
export interface LoopAnchor extends AnchorPoint {
  readonly loops: SegmentLoops;
}

/** Float noise allowed when comparing heard or file seconds (far under one frame at 192 kHz). */
const EPS = 1e-9;

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

function cursorOf(a: AnchorPoint, c: SegmentLoops): Cursor {
  const s = ticksToSeconds(c.grid, a.ticks);
  const r = regionAt(c, s);
  return { s, h: a.time, region: r ? c.regions.indexOf(r) : -1, passes: r ? Math.max(1, a.pass) : 1 };
}

/** The first wrap the playhead meets from `cur` playing on (regions without wraps left are played through), into `out`. */
function wrapAhead(cur: Cursor, c: SegmentLoops, out: Wrap): Wrap {
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
    const left = r.count === 0 ? Number.POSITIVE_INFINITY : r.count - passes;
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
 * Takes every wrap heard at or before `at` (in closed form: a forever loop may have run for hours), moving the cursor
 * to the last one. A wrap within float noise after `at` counts as at it, so a wrap time another query reported (a sum
 * in another order) is taken when asked for.
 */
function walkTo(cur: Cursor, c: SegmentLoops, at: number): void {
  const limit = at + EPS;
  for (let guard = 0; guard < 2 * c.regions.length + 2; guard++) {
    const w = wrapAhead(cur, c, wrapScratch);
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

// --- Whole questions ---------------------------------------------------------------------------------------------------

/**
 * A file position a query wants (`nextHeardOn`): the first one at or after file seconds `file` on `grid` (strictly after
 * it when `strict`), NaN when there is none. Pure: the walk may ask more than once.
 */
export type NextPoint = (grid: SegmentGrid, file: number, strict: boolean) => number;

/** `nextHeardOn`'s answer (one reused object): the point's heard time and file seconds, both NaN when there is none. */
export interface HeardPoint {
  at: number;
  file: number;
}

const heardScratch: HeardPoint = { at: Number.NaN, file: Number.NaN };

/** Heard seconds a strict query's point must be after the asked time. */
const STRICT_EPS = 1e-7;

/** The walk over compiled loops `c` from anchor point `a`, into `out`. */
function heardIn(c: SegmentLoops, a: AnchorPoint, after: number, next: NextPoint, strict: boolean, out: HeardPoint): HeardPoint {
  const from = Math.max(after, a.time);
  const cur = cursorOf(a, c);
  walkTo(cur, c, from);
  cur.s += from - cur.h; // no wrap between the cursor and `from`
  cur.h = from;
  const half = 0.5 / a.rate + EPS;
  const g = c.grid;
  for (let guard = 0; guard < 2 * c.regions.length + 4; guard++) {
    const w = wrapAhead(cur, c, wrapScratch);
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

/**
 * ADR 0285: the heard time of the first file position `next` names at or after the position heard at `after` (strictly
 * after `after` when `strict`), in the pass it is heard in. A point the playing loop wraps before (or within half a clip
 * frame of the wrap) is asked again from the region's start, one pass later; when no pass of the region holds one, the
 * walk goes on past the region's last wrap, and a region looping forever gives NaN. Nothing before the anchor is asked:
 * the search starts no earlier than `anchor.time`. Returns one reused object: read it, don't keep it.
 */
export function nextHeardOn(anchor: LoopAnchor, after: number, next: NextPoint, strict = false): HeardPoint {
  const out = heardScratch;
  out.at = Number.NaN;
  out.file = Number.NaN;
  if (!Number.isFinite(after) || !Number.isFinite(anchor.time)) return out;
  return heardIn(anchor.loops, anchor, after, next, strict, out);
}

let gridSpec: GridSpec = "bar";
const nextGridPoint: NextPoint = (g, file, strict) =>
  nextGridSeconds(g, strict ? ticksToSeconds(g, Math.round(secondsToTicks(g, file)) + 1) : file, gridSpec);

/** ADR 0285: `nextHeardOn` for the grid points of `spec` (strict: the one after the point on the tick heard at `after`). */
export function nextGridHeardOn(anchor: LoopAnchor, after: number, spec: GridSpec, strict = false): HeardPoint {
  gridSpec = spec;
  return nextHeardOn(anchor, after, nextGridPoint, strict);
}

/** ADR 0285: the position (fractional ticks) heard at `time` on a voice's anchor, NaN when unknown. */
export function ticksAtOn(anchor: LoopAnchor, time: number): number {
  const c = anchor.loops;
  if (!Number.isFinite(time) || !Number.isFinite(anchor.time)) return Number.NaN;
  const cur = cursorOf(anchor, c);
  if (time > anchor.time) walkTo(cur, c, time);
  return secondsToTicks(c.grid, cur.s + (time - cur.h));
}
