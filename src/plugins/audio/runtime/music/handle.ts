/**
 * `handle.music` and the `Audio` clock members of ADR 0166 (api-and-models §1.2, §1.3; architecture §4.5).
 *
 * Owners: **Q2** (skeleton); **P7** (W5) fills the M4a members: the per-frame snapshot behind the getters, `nextGrid`,
 * `audioHorizon` and `audioTimeAt`; **K3** (W8) fills `positionAt` and `judgedOffset`. `seek` delegates to
 * `music/seek.ts` (R7), `handle.trigger` to `music/stingers.ts` (R5), `handle.onMusic` to `musicSystem.ts` (K5).
 *
 * `handle.music` is `undefined`, never an empty object, for a non-music event (`musicHandleOf`). The getters share one
 * snapshot per display frame, recomputed on first read, with no allocation after it; none of them calls the core.
 *
 * P7's readings: the position is read through the player's anchor with P3's `ticksAt` and `heardTimeOf`
 * (one heard-time definition, loop passes unrolled). `segment` is null until the first run's
 * stamped start is heard. Grid points are at or after `Audio.time`.
 */
import type { GridPoint, GridSpec, MusicHandle, MusicPositionAt, MusicSeekResult } from "../../../../engine/audio/musicTypes";
import type { SegmentNode } from "../../../../engine/audio/musicFormat";
import {
  compileSegmentGrid, entrySeconds, exitSeconds, nextGridSeconds, secondsToNearestTick, spanAtTicks, ticksToPosition,
  ticksToSeconds, type SegmentGrid,
} from "../../../../engine/audio/musicGrid";
import { MUSIC_TICKS_PER_BEAT, type BarBeatTick } from "../../../../engine/audio/musicPosition";
import { audioBackend } from "../backend";
import { heardTimeOf, ticksAt, type GridAnchor } from "./anchors";
import { heardRunAt } from "./beatClock";
import { getCalibration } from "./calibration";
import { musicFrameSerial, playerOf, type MusicNodeRef, type MusicPlayer } from "./musicSystem";
import { seekMusic } from "./seek";
import { segmentClipSource, type SegmentRun } from "./segmentRun";
import type { Transition } from "./transition";

const EPS = 1e-6;

// --- Grids -----------------------------------------------------------------------------------------------------------

const grids = new WeakMap<object, SegmentGrid | null>();

/**
 * A segment's compiled grid (G1), cached per node object; null for a node that isn't a segment. The same compile as the
 * planner's (whose cache is private); the clip's length, when known, resolves an `"end"` exit.
 */
export function segmentGrid(node: MusicNodeRef): SegmentGrid | null {
  const cached = grids.get(node);
  if (cached !== undefined) return cached;
  let grid: SegmentGrid | null = null;
  const seg = node as Partial<SegmentNode>;
  if (node.type === "segment" && Array.isArray(seg.tempo) && Array.isArray(seg.cues)) {
    const clip = seg.tracks?.[0]?.clip;
    const facts = clip ? segmentClipSource().facts(clip) : undefined;
    grid = compileSegmentGrid(node as SegmentNode, facts && facts.rate > 0 ? { endSeconds: facts.frames / facts.rate } : {});
  }
  grids.set(node, grid);
  return grid;
}


/** The playing run with its anchor and grid at heard `now`; null while priming, before its stamped start, or stopped. */
function playing(player: MusicPlayer, now: number): { run: SegmentRun; anchor: GridAnchor; grid: SegmentGrid } | null {
  const run = player.run;
  const anchor = player.anchor;
  if (!run || !anchor) return null;
  if (player.state === "stopping" || player.state === "stopped" || player.state === "refused") return null;
  if (run.state === "cancelled" || run.state === "new" || run.state === "admitted" || run.state === "priming") return null;
  if (!(now + EPS >= run.startAt)) return null;
  const grid = segmentGrid(run.node);
  if (!grid) return null;
  return { run, anchor, grid };
}

/** The heard landing time of a change: the incoming segment's entry, else the exit point; NaN when not planned. */
function landingTime(t: Transition): number {
  const p = t.incoming?.point;
  return p !== undefined && Number.isFinite(p) ? p : t.exitAt;
}

// --- The per-frame snapshot --------------------------------------------------------------------------------------------

/** What the getters read; one object per handle, rewritten on the first read after the frame (or the state) moved. */
interface Snapshot {
  serial: number;
  time: number;
  run: SegmentRun | null;
  anchor: GridAnchor | null;
  transition: Transition | null;
  transitionState: string;
  segment: string | null;
  bar: number;
  beat: number;
  beatFraction: number;
  tempo: number;
  beatsPerBar: number;
  beatUnit: number;
  /** Reused as `handle.transition`'s value. */
  pending: { to: string; time: number };
  hasPending: boolean;
  scratch: BarBeatTick;
}

function newSnapshot(): Snapshot {
  return {
    serial: -1, time: Number.NaN, run: null, anchor: null, transition: null, transitionState: "", segment: null,
    bar: 1, beat: 1, beatFraction: 0, tempo: 0, beatsPerBar: 0, beatUnit: 0,
    pending: { to: "", time: 0 }, hasPending: false, scratch: { bar: 1, beat: 1, tick: 0 },
  };
}

function clearPosition(s: Snapshot): void {
  s.segment = null;
  s.bar = 1;
  s.beat = 1;
  s.beatFraction = 0;
  s.tempo = 0;
  s.beatsPerBar = 0;
  s.beatUnit = 0;
}

function refresh(player: MusicPlayer, s: Snapshot, now: number): void {
  s.serial = musicFrameSerial();
  s.time = now;
  s.run = player.run;
  s.anchor = player.anchor;
  s.transition = player.transition;
  s.transitionState = player.transition?.state ?? "";
  const cur = playing(player, now);
  if (cur) {
    const exact = Math.max(0, ticksAt(cur.anchor, now));
    const whole = Math.floor(exact);
    const pos = ticksToPosition(cur.grid, whole, s.scratch);
    if (pos) {
      const span = spanAtTicks(cur.grid, whole);
      s.segment = cur.run.node.id;
      s.bar = pos.bar;
      s.beat = pos.beat;
      s.beatFraction = (pos.tick + (exact - whole)) / MUSIC_TICKS_PER_BEAT;
      s.tempo = cur.grid.bpm[span] ?? 0;
      s.beatsPerBar = cur.grid.beatsPerBar[span] ?? 0;
      s.beatUnit = cur.grid.beatUnit[span] ?? 0;
    } else clearPosition(s);
  } else clearPosition(s);
  s.hasPending = false;
  const tr = player.transition;
  if (tr && s.segment !== null && tr.state !== "done" && tr.state !== "cancelled") {
    const time = landingTime(tr);
    if (Number.isFinite(time) && now <= time + EPS) {
      s.pending.to = tr.to.id;
      s.pending.time = time;
      s.hasPending = true;
    }
  }
}

/** The public `handle.music` over one player. One object per instance, made with the player. */
class PlayerMusicHandle implements MusicHandle {
  private readonly snap = newSnapshot();

  constructor(private readonly player: MusicPlayer) {}

  /** This frame's snapshot: recomputed on the first read after the frame, the time or the playing state moved. */
  private read(): Snapshot {
    const s = this.snap;
    const p = this.player;
    const now = audioBackend().time;
    if (s.serial !== musicFrameSerial() || s.time !== now || s.run !== p.run || s.anchor !== p.anchor
      || s.transition !== p.transition || s.transitionState !== (p.transition?.state ?? "")) refresh(p, s, now);
    return s;
  }

  get segment(): string | null { return this.read().segment; }
  get bar(): number { return this.read().bar; }
  get beat(): number { return this.read().beat; }
  get beatFraction(): number { return this.read().beatFraction; }
  get tempo(): number { return this.read().tempo; }
  get beatsPerBar(): number { return this.read().beatsPerBar; }
  get beatUnit(): number { return this.read().beatUnit; }
  get time(): number { return this.read().time; }
  get transition(): { to: string; time: number } | null {
    const s = this.read();
    return s.hasPending ? s.pending : null;
  }

  nextGrid(spec: GridSpec): GridPoint | null {
    return nextGrid(this.player, spec);
  }

  positionAt(performanceTime: number): MusicPositionAt {
    return positionAt(this.player, performanceTime);
  }

  seek(to: string): MusicSeekResult {
    return seekMusic(this.player, to);
  }
}

/** `createMusicPlayer` (musicSystem.ts) makes the player's handle here. */
export function createMusicHandle(player: MusicPlayer): MusicHandle {
  return new PlayerMusicHandle(player);
}

/** `handle.music` (`Audio.ts`): the instance's music handle, or undefined when it isn't (or is no longer) music. */
export function musicHandleOf(instance: object): MusicHandle | undefined {
  return playerOf(instance)?.handle;
}

function gridPoint(g: SegmentGrid, fileSeconds: number, heard: number, segment: string): GridPoint {
  const pos = ticksToPosition(g, secondsToNearestTick(g, fileSeconds));
  return { time: heard, bar: pos?.bar ?? 1, beat: pos?.beat ?? 1, segment };
}

/**
 * P7: the next grid point of `spec` at or after this frame's `Audio.time`; for a pending change the points after
 * `transition.time` are the incoming segment's. Null when not playing, or past the exit with nothing following.
 */
export function nextGrid(player: MusicPlayer, spec: GridSpec): GridPoint | null {
  const now = audioBackend().time;
  const cur = playing(player, now);
  if (!cur) return null;
  const { grid: g, anchor: a } = cur;
  const here = ticksAt(a, now);
  if (!Number.isFinite(here)) return null;
  const tr = player.transition;
  const pending = tr !== null && tr.state !== "done" && tr.state !== "cancelled" ? tr : null;
  const landing = pending ? landingTime(pending) : Number.NaN;
  // The playing segment's own next point, kept while it is inside the exit and not after the change lands.
  const p = nextGridSeconds(g, ticksToSeconds(g, here), spec);
  const exit = exitSeconds(g);
  const heard = heardTimeOf(a, secondsToNearestTick(g, p));
  if ((exit === null || p <= exit + EPS) && !(heard > landing + EPS)) return gridPoint(g, p, heard, cur.run.node.id);
  if (!pending || !Number.isFinite(landing)) return null;
  // After the change: the incoming segment's grid, anchored at its entry on the landing time.
  const node = pending.incoming?.run.node ?? (pending.to.type === "segment" ? pending.to : null);
  const gn = node ? segmentGrid(node) : null;
  if (!node || !gn) return null;
  const entry = entrySeconds(gn);
  const pn = nextGridSeconds(gn, entry, spec);
  const exitN = exitSeconds(gn);
  if (exitN !== null && pn > exitN + EPS) return null;
  return gridPoint(gn, pn, landing + (pn - entry), node.id);
}

const NOT_PLAYING: Readonly<MusicPositionAt> = Object.freeze({ segment: null, bar: 0, beat: 0, beatFraction: 0, nearestBeatTime: 0, offset: 0, judged: 0 });

/** Heard time of beat tick `beat`, given the grid is at `exact` ticks at heard `time` (the file-seconds distance, so loop passes stay unrolled). */
function beatTimeAt(grid: SegmentGrid, exact: number, beat: number, time: number): number {
  return time + (ticksToSeconds(grid, beat) - ticksToSeconds(grid, exact));
}

/**
 * K3: map an input timestamp (`performance.now()` ms, as `event.timeStamp`) to the music: `Audio.timeAt` of it (raw heard
 * time, calibration not applied, R18), then the run heard at that time (K1's `heardRunAt`: the successor from its
 * landing on) read through its anchor with `ticksAt`. `segment`, `bar`, `beat` and `beatFraction` are the position heard
 * then; `nearestBeatTime` is the heard time of the nearest beat that is actually heard (a beat a change cuts off is
 * skipped for the neighbour or the incoming segment's); `offset = time - nearestBeatTime` (positive: late);
 * `judged = judgedOffset(offset)`. Before the grid (a pickup) bar and beat read 1 and 1 as `handle.music` does, while
 * the offset is still against the pickup's own beats. `segment` null (the other fields 0) when the music is not playing
 * then. It reads anchors only, never a playhead (so the tracker's rate, F-18, is not involved).
 */
export function positionAt(player: MusicPlayer, performanceTime: number): MusicPositionAt {
  const time = audioTimeAt(performanceTime);
  if (!Number.isFinite(performanceTime) || !Number.isFinite(time)) return { ...NOT_PLAYING };
  if (player.state === "stopping" || player.state === "stopped" || player.state === "refused") return { ...NOT_PLAYING };
  const hit = heardRunAt(player, time);
  if (!hit) return { ...NOT_PLAYING };
  const { run, anchor, grid } = hit;
  const raw = ticksAt(anchor, time);
  if (!Number.isFinite(raw)) return { ...NOT_PLAYING };
  // Float noise in the anchor's tick (about 1e-6 of a tick) must not read a time exactly on a beat as the end of the one before.
  const exact = Math.abs(raw - Math.round(raw)) < 1e-3 ? Math.round(raw) : raw;
  const id = run.node.id;
  const whole = Math.floor(Math.max(0, exact));
  const pos = ticksToPosition(grid, whole);
  const beatFraction = pos ? (pos.tick + (Math.max(0, exact) - whole)) / MUSIC_TICKS_PER_BEAT : 0;
  const bar = pos?.bar ?? 1;
  const beat = pos?.beat ?? 1;
  // Candidates: this run's beats around `exact` (each must be heard in this run: `heardRunAt` at its time names the run),
  // and for one a change cuts off, the beat nearest it in the run heard there.
  const T = MUSIC_TICKS_PER_BEAT;
  let best = Number.NaN;
  let bestAbs = Number.POSITIVE_INFINITY;
  const consider = (g: SegmentGrid, e: number, atTime: number, beatTicks: number, runWanted: SegmentRun): void => {
    const t = beatTimeAt(g, e, beatTicks, atTime);
    const h = heardRunAt(player, t);
    if (!h) return;
    if (h.run !== runWanted) {
      // A beat past a change is the run heard there's: its own nearest beat to that instant (one level, no recursion).
      if (runWanted === run) {
        const run2 = h.run, grid2 = h.grid;
        const e2 = ticksAt(h.anchor, t);
        if (Number.isFinite(e2)) consider(grid2, e2, t, Math.round(e2 / T) * T, run2);
      }
      return;
    }
    const d = Math.abs(t - time);
    if (d < bestAbs) { bestAbs = d; best = t; }
  };
  const mid = Math.round(exact / T) * T;
  consider(grid, exact, time, mid, run);
  const lo = Math.floor(exact / T) * T;
  if (lo !== mid) consider(grid, exact, time, lo, run);
  const hi = Math.ceil(exact / T) * T;
  if (hi !== mid && hi !== lo) consider(grid, exact, time, hi, run);
  if (Number.isNaN(best)) best = beatTimeAt(grid, exact, mid, time);
  const offset = time - best;
  return { segment: id, bar, beat, beatFraction, nearestBeatTime: best, offset, judged: judgedOffset(offset) };
}

/**
 * K3: `MusicPositionAt.judged`: the raw offset less `Audio.calibration` (R18: calibration is applied only here, never in
 * `Audio.timeAt` or `offset`). Output latency is already in the heard clock `timeAt` reads, so it is not subtracted
 * again. Rh2 owns the stored calibration (`getCalibration`; 0 until it ships). A non-finite offset passes through.
 */
export function judgedOffset(offset: number): number {
  return offset - getCalibration();
}

/**
 * P7: `Audio.horizon`: the earliest heard time a stamped start is exact for a decoded clip (now + lookahead). A backend
 * without `horizon` (the Babylon fallback): `Audio.time`.
 */
export function audioHorizon(): number {
  const b = audioBackend();
  return b.horizon?.() ?? b.time;
}

/**
 * P7: `Audio.timeAt(performanceTime)`: the raw heard time of a `performance.now()` instant (ms); calibration is never
 * applied (R18). `Audio.time` before the clock has an estimate, and on a backend without a heard clock.
 */
export function audioTimeAt(performanceTime: number): number {
  const b = audioBackend();
  return b.timeAt?.(performanceTime) ?? b.time;
}
