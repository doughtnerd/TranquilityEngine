// ADR 0171 amended by 0172 (M5a, task Pf2; api-and-models §7 `cursorModel.ts`): the profiler's cursor, a pure model (no
// DOM, no Preact). It owns where the tables are read: live (the newest STATUS, following a growing capture), paused
// (held at a time), or scrubbing (a drag in progress). It steps by one STATUS block and jumps to the previous or next
// underrun, late command, ladder step or marker.
//
// Times are seconds on the viewport axis (0 = the capture's first record), as `timelineModel.ts` and `cpuTrack.ts` use;
// `axisTime` turns the cursor into the Worker's axis seconds for `ProfileSource.seek`. A file has no live mode; a live
// view starts live. Scrubbing a live capture pauses it (the cursor stays where it was dropped; `goLive` returns).
//
// The jump targets are sorted arrays built from one raw `statusColumns` answer (`cursorTargets`); the cursor holds
// them and is told when they or the duration grow (`setTargets`, `setDuration`). Every change of mode or time bumps
// `revision`, so an async `seek` answer that arrives after a newer move is dropped (`seekAtCursor`).
import { RANGE_SECONDS, type CaptureMarkerAt, type CaptureRangeColumns, type CaptureSeekState } from "../../runtime/capture/reader";
import type { ProfileSource } from "./profilerSource";
import { counterTicks, ladderSeries, rangeColumn } from "./cpuTrack";

export type CursorMode = "live" | "paused" | "scrubbing";
/** What the cursor can jump between. */
export type JumpKind = "underrun" | "lateCommand" | "ladder" | "marker";
export type JumpDirection = "previous" | "next";

/** The STATUS columns `cursorTargets` reads. */
export const CURSOR_COLUMNS = ["underruns", "lateCommands", "m3Shed", "loudShed"] as const;

/** Sorted times (seconds on the viewport axis) of everything the cursor steps to. */
export interface CursorTargets {
  /** One per STATUS record: what step forward and back visit. */
  readonly status: Float64Array;
  readonly underrun: Float64Array;
  readonly lateCommand: Float64Array;
  /** Samples at which the ladder rose or fell. */
  readonly ladder: Float64Array;
  readonly marker: Float64Array;
}

export const NO_TARGETS: CursorTargets = {
  status: new Float64Array(0), underrun: new Float64Array(0), lateCommand: new Float64Array(0), ladder: new Float64Array(0), marker: new Float64Array(0),
};

function mergeSorted(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length || j < b.length) out[k++] = j >= b.length || (i < a.length && a[i]! <= b[j]!) ? a[i++]! : b[j++]!;
  return out;
}

/**
 * The targets of a raw `statusColumns(source, CURSOR_COLUMNS)` answer (times already on the viewport axis) and the
 * source's markers (Worker axis seconds, rebased here by `startSeconds`).
 */
export function cursorTargets(cols: CaptureRangeColumns, markers: readonly CaptureMarkerAt[], startSeconds = 0): CursorTargets {
  const ladder = ladderSeries(cols);
  const marker = Float64Array.from(markers, (m) => m.seconds - startSeconds).sort();
  return {
    status: Float64Array.from(rangeColumn(cols, RANGE_SECONDS)),
    underrun: counterTicks(cols, "underruns"),
    lateCommand: counterTicks(cols, "lateCommands"),
    ladder: mergeSorted(ladder.shed, ladder.restored),
    marker,
  };
}

/** Index of the first element greater than `t` (strictly). */
function upperBound(a: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the first element not less than `t`. */
function lowerBound(a: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** What a view reads of the cursor. */
export interface CursorSnapshot {
  readonly mode: CursorMode;
  readonly time: number;
  readonly revision: number;
}

export class CursorModel {
  private m: CursorMode;
  private t = 0;
  private dur = 0;
  private targets: CursorTargets = NO_TARGETS;
  private rev = 0;
  private readonly canGoLive: boolean;

  /** `live`: the source grows, so the cursor starts live and may return to it; a file starts paused at 0. */
  constructor(opts: { live: boolean }) {
    this.canGoLive = opts.live;
    this.m = opts.live ? "live" : "paused";
  }

  get mode(): CursorMode {
    return this.m;
  }

  /** The cursor's time: while live, the newest STATUS (the duration before any). */
  get time(): number {
    return this.m === "live" ? this.liveTime() : this.t;
  }

  get duration(): number {
    return this.dur;
  }

  /** Bumped by every change of mode or time. */
  get revision(): number {
    return this.rev;
  }

  snapshot(): CursorSnapshot {
    return { mode: this.m, time: this.time, revision: this.rev };
  }

  /** The cursor in the Worker's axis seconds (`ProfileSource.seek`'s argument). */
  axisTime(startSeconds: number): number {
    return this.time + startSeconds;
  }

  /** The capture grew (or a viewport reset): a held cursor past the new end moves to it. */
  setDuration(duration: number): void {
    this.dur = Number.isFinite(duration) && duration > 0 ? duration : 0;
    if (this.m === "live") this.rev++;
    else if (this.t > this.dur) this.set(this.m, this.dur);
  }

  setTargets(targets: CursorTargets): void {
    this.targets = targets;
    if (this.m === "live") this.rev++;
  }

  /** Follows the newest STATUS again. False for a file. */
  goLive(): boolean {
    if (!this.canGoLive) return false;
    if (this.m !== "live") {
      this.m = "live";
      this.rev++;
    }
    return true;
  }

  /** Holds the cursor where it is (a live cursor stops at its newest STATUS). */
  pause(): void {
    this.set("paused", this.time);
  }

  /** A click: paused at `t` (clamped to the capture). */
  seekTo(t: number): void {
    this.set("paused", this.clamp(t));
  }

  /** A drag begins, or moves, at `t`: scrubbing from live or paused. */
  scrub(t: number): void {
    this.set("scrubbing", this.clamp(t));
  }

  /** The drag ends: paused where it stopped. */
  endScrub(): void {
    if (this.m === "scrubbing") this.set("paused", this.t);
  }

  /** One STATUS block later than the cursor. False (and unchanged) at the last one, and while live. */
  stepForward(): boolean {
    if (this.m === "live") return false;
    const s = this.targets.status;
    const i = upperBound(s, this.t);
    if (i >= s.length) return false;
    this.set("paused", s[i]!);
    return true;
  }

  /** One STATUS block earlier than the cursor (from live: earlier than the newest). False (and unchanged) at the first. */
  stepBack(): boolean {
    const s = this.targets.status;
    const i = lowerBound(s, this.time) - 1;
    if (i < 0) return false;
    this.set("paused", s[i]!);
    return true;
  }

  /** The time of the nearest `kind` in `direction` from the cursor, or null at the end of that kind. */
  find(kind: JumpKind, direction: JumpDirection): number | null {
    const a = this.targets[kind];
    const t = this.time;
    if (direction === "next") {
      const i = upperBound(a, t);
      return i < a.length ? a[i]! : null;
    }
    const i = lowerBound(a, t) - 1;
    return i >= 0 ? a[i]! : null;
  }

  has(kind: JumpKind, direction: JumpDirection): boolean {
    return this.find(kind, direction) !== null;
  }

  /** Jumps (paused) to the previous or next `kind`. False and unchanged when there is none. */
  jump(kind: JumpKind, direction: JumpDirection): boolean {
    const at = this.find(kind, direction);
    if (at === null) return false;
    this.set("paused", at);
    return true;
  }

  private liveTime(): number {
    const s = this.targets.status;
    return s.length ? s[s.length - 1]! : this.dur;
  }

  private clamp(t: number): number {
    return Number.isFinite(t) ? Math.min(Math.max(t, 0), this.dur) : 0;
  }

  private set(mode: CursorMode, time: number): void {
    if (mode === this.m && (mode === "live" || time === this.t)) return;
    this.m = mode;
    this.t = time;
    this.rev++;
  }
}

/**
 * The state at the cursor: `source.seek` at its axis time. Null when the cursor moved while the Worker answered (a
 * newer request owns the table), so a drag never paints a stale position.
 */
export async function seekAtCursor(source: ProfileSource, cursor: CursorModel): Promise<{ state: CaptureSeekState; revision: number } | null> {
  const revision = cursor.revision;
  const state = await source.seek(cursor.axisTime(source.startSeconds));
  return cursor.revision === revision ? { state, revision } : null;
}
