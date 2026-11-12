/**
 * The beat clock, design A (ADR 0166 api-and-models §1.1 `MusicEvent`, §1.4; architecture §4.5, §3.7).
 *
 * Owner: **K1** (W7); K4 adds tests on the spike's jitter traces. Q2 wrote the skeleton. K2 dispatches what it predicts
 * (`musicSystem.ts` `dispatchMusic`).
 *
 * **Model.** The music a player plays is one timeline of heard times (`Audio.time`'s base):
 * - the playing run, read through its anchor (`player.anchor`, P3) with loop passes unrolled (`heardTimeOf`,
 *   `predictWrap`, `advanceAnchor` on a scratch copy, so the player's own anchor is never moved here);
 * - a committed successor (a stamped transition's incoming run, or a stamped `player.next` that starts after the
 *   playing run) on its own anchor, `anchorRun(next, next.startAt)`. At the seam the successor wins: the playing run's
 *   events stop before the successor's entry (its landing), the successor's start there.
 *
 * Beats are the multiples of 960 ticks from `1:1:0`, bars the bar lines of the tempo map, cues the segment's cues. A
 * segment's beats and bars stop before its exit cue (a cue on the exit is still reached); the pickup (negative ticks)
 * has none. A run that isn't stamped yet (priming, planned) has no events: it may still move.
 *
 * **Dispatch (R17).** `predictDue` returns, per kind, the events heard before `now` + Δ̄ past the cursor: one call, for
 * the latest, with `missed` = the others (cues add `skippedCues`; several cues on one tick are one call). A beat is so
 * fired in the display frame whose window holds its heard time: the S4 rule (architecture §4.5).
 *
 * **Cursors.** A cursor is the heard time of the last event it consumed plus the run that event came from, never an
 * index a correction or a re-anchor could renumber. Each call first re-seats them (`resyncBeats`):
 * - a late start, hold or resume shifts a run's `startAt` and anchor by its slip (`applySlip`); a cursor on that run
 *   moves by the same amount, so the event it fired stays the last one: nothing doubles or skips, whatever the size;
 * - a seek, a transition or a playlist step is a new run later on the same timeline, so the cursor just continues; a
 *   seek's skipped span fires nothing (R7);
 * - a recovery (rebuild, crash, rate change, architecture §3.7) re-enters the same segment at its heard position after
 *   a gap: the first call from the new run carries `missed` = the events of the gap, one coalesced call per kind;
 * - a context swap keeps `Audio.time` monotonic (`ClockMap.rebase`) and anchors are heard seconds: nothing to do;
 * - a clock step backwards can't re-fire: owed events are only those after the cursor.
 *
 * **Held** (Rh1): while `beats.held`, nothing fires and the cursors stay; on release the backlog coalesces.
 *
 * A call costs a few binary searches over the tempo map and allocates nothing, except a coalesced cue call's
 * `skippedCues` and the successor's anchor once per successor.
 */
import type { MusicEvent, MusicKind } from "../../../../engine/audio/musicTypes";
import type { SegmentNode } from "../../../../engine/audio/musicFormat";
import {
  compileSegmentGrid, nextBarTicks, secondsToTicks, spanAtTicks, ticksToPosition, ticksToSeconds, type SegmentGrid,
} from "../../../../engine/audio/musicGrid";
import { MUSIC_TICKS_PER_BEAT, type BarBeatTick } from "../../../../engine/audio/musicPosition";
import { advanceAnchor, anchorRun, heardTimeOf, predictWrap, type GridAnchor } from "./anchors";
import { segmentGrid } from "./handle";
import type { MusicNodeRef, MusicPlayer } from "./musicSystem";
import type { SegmentRun } from "./segmentRun";

/** Two events of one kind closer than this (seconds) are the same event: far under a frame at any rate. */
const TIME_EPS = 1e-7;
/** Ticks of float noise allowed when finding the grid line at a heard position (a tick is >= 60 us up to 1000 bpm). */
const TICK_EPS = 1e-4;
/** At most this many events are walked in one call (a hidden tab for hours on a short loop). */
const MAX_WALK = 100_000;

/** One kind's cursor. K1 added every field but `last`. */
export interface BeatCursor {
  /** Events of this kind consumed (fired or coalesced) since the state was made, -1 before any; a count, not a grid index. */
  last: number;
  /** Heard time (seconds) of the last event consumed, or just before the seat: events after it are owed. */
  time: number;
  /** The run that event came from (null: seated, nothing fired since); a slip of this run moves `time` with it. */
  run: SegmentRun | null;
  /** That run's `startAt` when `time` was last re-seated against it. */
  startAt: number;
}

type MutableAnchor = { -readonly [K in keyof GridAnchor]: GridAnchor[K] };

/** The player's beat prediction state. K1 added the fields after `held`. */
export interface BeatState {
  readonly beat: BeatCursor;
  readonly bar: BeatCursor;
  readonly cue: BeatCursor;
  /** Rhythm mode (Rh1): callbacks held during a recovery. */
  held: boolean;
  /** The playing run last seen live, and a copy of its anchor then. */
  liveRun: SegmentRun | null;
  readonly liveAnchor: MutableAnchor;
  /** Recoveries the player had counted (`counters.recoveries`) when `liveRun` was last seen. */
  recoveries: number;
  /** The run a recovery replaced, and its anchor's last live copy: a cursor still on it counts the gap. */
  lostRun: SegmentRun | null;
  readonly lostAnchor: MutableAnchor;
  /** The committed successor's anchor, cached for its run and `startAt`. */
  successor: SegmentRun | null;
  successorStartAt: number;
  successorAnchor: GridAnchor | null;
}

function newCursor(): BeatCursor {
  return { last: -1, time: Number.NEGATIVE_INFINITY, run: null, startAt: Number.NaN };
}

function blankAnchor(): MutableAnchor {
  return { segment: "", ticks: 0, time: Number.NaN, pass: 1, node: { id: "", type: "" }, rate: 48_000 };
}

/** K1: a fresh beat state (nothing fired yet; `resyncBeats` seats it at the time it is first used). */
export function createBeatState(): BeatState {
  return {
    beat: newCursor(), bar: newCursor(), cue: newCursor(), held: false,
    liveRun: null, liveAnchor: blankAnchor(), recoveries: 0, lostRun: null, lostAnchor: blankAnchor(),
    successor: null, successorStartAt: Number.NaN, successorAnchor: null,
  };
}

// --- Grids -------------------------------------------------------------------------------------------------------------

const fallbackGrids = new WeakMap<object, SegmentGrid | null>();

/** The segment's grid: `handle.ts`'s cached compile; a node without a `cues` list compiles here, once. */
function gridOf(node: MusicNodeRef): SegmentGrid | null {
  const g = segmentGrid(node);
  if (g) return g;
  let f = fallbackGrids.get(node);
  if (f === undefined) {
    const seg = node as Partial<SegmentNode>;
    f = node.type === "segment" && Array.isArray(seg.tempo) ? compileSegmentGrid({ ...seg, cues: seg.cues ?? [] } as SegmentNode) : null;
    fallbackGrids.set(node, f);
  }
  return f;
}

// --- Sources -----------------------------------------------------------------------------------------------------------

/** A run on the timeline: its events heard in [from, until), through its anchor's pass walk. */
interface Source {
  run: SegmentRun | null;
  anchor: GridAnchor | null;
  grid: SegmentGrid | null;
  from: number;
  until: number;
  /** R4b's region state applies (a released `while` region stops wrapping): the playing run only. */
  playing: boolean;
}

const srcA: Source = { run: null, anchor: null, grid: null, from: 0, until: 0, playing: true };
const srcB: Source = { run: null, anchor: null, grid: null, from: 0, until: 0, playing: false };

const liveRunState = (run: SegmentRun): boolean => run.state === "stamped" || run.state === "playing" || run.state === "ending";
const audible = (player: MusicPlayer): boolean =>
  player.state !== "stopping" && player.state !== "stopped" && player.state !== "refused";
const isSuccessor = (r: SegmentRun, run: SegmentRun): boolean =>
  r !== run && liveRunState(r) && Number.isFinite(r.startAt) && r.startAt > run.startAt;

/** The committed successor of the playing run (a stamped incoming run, or a stamped `player.next`), or null. */
function successorOf(player: MusicPlayer, run: SegmentRun): SegmentRun | null {
  const t = player.transition;
  const inc = t && t.state !== "done" && t.state !== "cancelled" ? t.incoming?.run ?? null : null;
  if (inc && isSuccessor(inc, run)) return inc;
  const next = player.next; // after a landing it is the outgoing run ringing out: it starts earlier, so it isn't taken
  return next && isSuccessor(next, run) ? next : null;
}

/** Fills `srcA` (the playing run) and `srcB` (its successor) for the player now; false when nothing can be heard. */
function sources(player: MusicPlayer, st: BeatState): boolean {
  srcA.run = null;
  srcB.run = null;
  if (!audible(player)) return false;
  const run = player.run;
  if (!run || !liveRunState(run) || !Number.isFinite(run.startAt)) return false;
  const a = player.anchor && player.anchor.segment === run.node.id ? player.anchor : null;
  srcA.run = run;
  srcA.anchor = a ?? anchorRun(run, run.startAt);
  srcA.grid = gridOf(run.node);
  srcA.from = Number.NEGATIVE_INFINITY;
  srcA.until = Number.POSITIVE_INFINITY;
  srcA.playing = true;
  const next = successorOf(player, run);
  if (next) {
    if (st.successor !== next || st.successorStartAt !== next.startAt || !st.successorAnchor) {
      st.successor = next;
      st.successorStartAt = next.startAt;
      st.successorAnchor = anchorRun(next, next.startAt);
    }
    const g = gridOf(next.node);
    const an = st.successorAnchor;
    // The landing: the successor's entry (after its pre-entry), else its start (a seek lands where it starts).
    let cut = next.startAt;
    if (g && Number.isFinite(g.entryTicks) && g.entryTicks >= an.ticks) cut = Math.max(cut, heardTimeOf(an, g.entryTicks));
    srcB.run = next;
    srcB.anchor = an;
    srcB.grid = g;
    srcB.from = cut;
    srcB.until = Number.POSITIVE_INFINITY;
    srcA.until = cut;
  } else {
    st.successor = null;
    st.successorAnchor = null;
  }
  return srcA.grid !== null || srcB.grid !== null;
}

// --- The walk ----------------------------------------------------------------------------------------------------------

/** The scratch anchor a walk moves through loop passes, and the player-shaped view `anchors.ts` reads it through. */
const work: MutableAnchor = blankAnchor();
const view = { anchor: work as GridAnchor, run: null, regions: null } as unknown as MusicPlayer;

/** An event a walk found. */
interface Found {
  time: number;
  ticks: number;
  run: SegmentRun | null;
  grid: SegmentGrid | null;
  /** Cues: the last and the first index in `grid.cueNames` of the cues on the tick. */
  cue: number;
  cueFirst: number;
}

const newFound = (): Found => ({ time: Number.NaN, ticks: 0, run: null, grid: null, cue: -1, cueFirst: -1 });
const found = newFound();
const foundA = newFound();
const foundB = newFound();
const last = newFound();

function copyFound(to: Found, from: Found): void {
  to.time = from.time;
  to.ticks = from.ticks;
  to.run = from.run;
  to.grid = from.grid;
  to.cue = from.cue;
  to.cueFirst = from.cueFirst;
}

/** The first grid line of `kind` at or after `x` ticks (never before 0: the pickup has none), NaN when none. */
function lineAtOrAfter(g: SegmentGrid, kind: MusicKind, x: number, out: Found): number {
  const t = Math.max(0, x - TICK_EPS);
  if (kind === "beat") return Math.ceil(t / MUSIC_TICKS_PER_BEAT) * MUSIC_TICKS_PER_BEAT;
  if (kind === "bar") return nextBarTicks(g, t);
  let best = Number.NaN;
  for (let i = 0; i < g.cueTicks.length; i++) {
    const c = g.cueTicks[i]!;
    if (!(c >= t)) continue;
    if (Number.isNaN(best) || c < best) {
      best = c;
      out.cueFirst = i;
      out.cue = i;
    } else if (c === best) out.cue = i;
  }
  return best;
}

/**
 * The first event of `kind` on `src` heard strictly after `after` (at or after `src.from`, before `src.until`), into
 * `out`; false when none. Loop passes are walked on the scratch anchor, wrap by wrap as `predictWrap` sees them.
 */
function nextOn(src: Source, kind: MusicKind, after: number, out: Found): boolean {
  const g = src.grid;
  const a = src.anchor;
  if (!g || !a || !Number.isFinite(a.time)) return false;
  Object.assign(work, a);
  (view as { regions: unknown }).regions = src.playing ? src.run?.player.regions ?? null : null;
  const lo = Math.max(after, src.from - TIME_EPS);
  // To the pass heard at `lo`, when a wrap really comes before it.
  if (lo > work.time) {
    const w = predictWrap(view, work.time);
    if (Number.isFinite(w) && w <= lo) advanceAnchor(view, lo);
  }
  const exit = Number.isFinite(g.exitTicks) ? g.exitTicks : Number.POSITIVE_INFINITY;
  let from = lo;
  for (let guard = 0; guard < 64; guard++) {
    // The position heard at `from`, linear within the pass (no wrap between the scratch anchor and it).
    const x = from <= work.time ? work.ticks : secondsToTicks(g, ticksToSeconds(g, work.ticks) + (from - work.time));
    let c = lineAtOrAfter(g, kind, Math.max(x, work.ticks), out);
    if (Number.isNaN(c)) return false;
    let h = heardTimeOf(work, c);
    if (!(h > after + TIME_EPS)) {
      // The cursor's own event: the one after it.
      c = lineAtOrAfter(g, kind, c + 1, out);
      if (Number.isNaN(c)) return false;
      h = heardTimeOf(work, c);
    }
    const wrap = predictWrap(view, Math.max(from, work.time));
    if (Number.isFinite(wrap) && h >= wrap - TIME_EPS) {
      // The pass ends first: go on from the region's start, one pass later.
      advanceAnchor(view, wrap);
      if (!(work.time >= wrap - TIME_EPS)) return false;
      from = wrap;
      continue;
    }
    // Beats and bars stop before the exit cue; a cue on it is still reached. At a seam the successor wins.
    if (kind === "cue" ? c > exit + TICK_EPS : c >= exit - TICK_EPS) return false;
    if (!Number.isFinite(h) || !(h < src.until - TIME_EPS)) return false;
    out.time = h;
    out.ticks = c;
    out.run = src.run;
    out.grid = g;
    return true;
  }
  return false;
}

/** The first event of `kind` on the timeline (playing run, then successor) heard after `after`, into `found`. */
function nextEvent(kind: MusicKind, after: number): boolean {
  const okA = srcA.run !== null && nextOn(srcA, kind, after, foundA);
  const okB = srcB.run !== null && nextOn(srcB, kind, after, foundB);
  if (okA && (!okB || foundA.time <= foundB.time)) copyFound(found, foundA);
  else if (okB) copyFound(found, foundB);
  else return false;
  return true;
}

// --- Re-seating ----------------------------------------------------------------------------------------------------------

function recoveriesOf(player: MusicPlayer): number {
  let n = 0;
  const r = player.counters.recoveries;
  for (const k in r) n += r[k] ?? 0;
  return n;
}

function seat(c: BeatCursor, now: number): void {
  c.time = now - TIME_EPS;
  c.run = null;
  c.startAt = Number.NaN;
}

/** A slip of the cursor's run (`applySlip` moved its `startAt` and anchor) moves the cursor with it. */
function follow(c: BeatCursor): void {
  const r = c.run;
  if (!r || !Number.isFinite(r.startAt) || !Number.isFinite(c.startAt) || r.startAt === c.startAt) return;
  c.time += r.startAt - c.startAt;
  c.startAt = r.startAt;
}

/**
 * K1: re-seat the cursors after a slip, a seek, a transition or a recovery so the next dispatch neither doubles nor
 * skips (see the header). `predictDue` calls it itself; a caller needs it only to bring the state up to date without
 * dispatching (once per frame is enough, more is harmless). Makes the state on first use, seated at `now`: events
 * heard before `now` aren't owed.
 */
export function resyncBeats(player: MusicPlayer, now: number): void {
  let st = player.beats;
  if (!st) {
    st = player.beats = createBeatState();
    seat(st.beat, now);
    seat(st.bar, now);
    seat(st.cue, now);
  }
  follow(st.beat);
  follow(st.bar);
  follow(st.cue);
  const rec = recoveriesOf(player);
  const run = player.run;
  const a = player.anchor;
  if (run && a && a.segment === run.node.id && liveRunState(run) && Number.isFinite(run.startAt)) {
    if (run !== st.liveRun) {
      if (st.liveRun && rec !== st.recoveries) {
        // A recovery re-entered (architecture §3.7): keep the lost timeline for the gap.
        st.lostRun = st.liveRun;
        Object.assign(st.lostAnchor, st.liveAnchor);
      }
      st.liveRun = run;
    }
    Object.assign(st.liveAnchor, a);
    st.recoveries = rec;
  }
}

/**
 * K1: forget the backlog: every cursor seated at `now`, so the events owed are those heard from `now` on. For a
 * subscription that starts (K2: the mask goes from 0 to a kind) or a stretch the caller chooses not to report.
 */
export function seatBeats(player: MusicPlayer, now: number): void {
  if (!player.beats) {
    resyncBeats(player, now);
    return;
  }
  const st = player.beats;
  seat(st.beat, now);
  seat(st.bar, now);
  seat(st.cue, now);
}

/** Events of `kind` on the lost run's timeline heard in (from, to): a recovery's gap. */
function gapEvents(st: BeatState, kind: MusicKind, from: number, to: number): number {
  const lost = st.lostRun;
  const g = lost ? gridOf(lost.node) : null;
  if (!lost || !g || !Number.isFinite(st.lostAnchor.time)) return 0;
  const gap: Source = { run: lost, anchor: st.lostAnchor, grid: g, from: Number.NEGATIVE_INFINITY, until: to, playing: false };
  let n = 0;
  let t = from;
  while (n < MAX_WALK && nextOn(gap, kind, t, foundA)) {
    n++;
    t = foundA.time;
  }
  return n;
}

// --- Queries -------------------------------------------------------------------------------------------------------------

const scratchState = createBeatState();
const heard = { run: null as unknown as SegmentRun, anchor: null as unknown as GridAnchor, grid: null as unknown as SegmentGrid };

/**
 * K1, for K3's `positionAt` (and anyone reading the grid at a heard time): the run heard at `time` (seconds,
 * `Audio.time`'s base) on the beat clock's timeline, its anchor and grid: the committed successor from its landing on,
 * else the playing run. Null when nothing is heard then (not stamped, stopped, or before the run's start). Read
 * `ticksAt(anchor, time)` on it for the position. The object is reused: read it, don't keep it. Moves no cursor.
 */
export function heardRunAt(player: MusicPlayer, time: number): { readonly run: SegmentRun; readonly anchor: GridAnchor; readonly grid: SegmentGrid } | null {
  if (!Number.isFinite(time) || !sources(player, player.beats ?? scratchState)) return null;
  const src = srcB.run && srcB.grid && time >= srcB.from - TIME_EPS ? srcB : srcA;
  if (!src.run || !src.anchor || !src.grid || time < src.run.startAt - TIME_EPS) return null;
  heard.run = src.run;
  heard.anchor = src.anchor;
  heard.grid = src.grid;
  return heard;
}

// --- Dispatch ------------------------------------------------------------------------------------------------------------

const pos: BarBeatTick = { bar: 1, beat: 1, tick: 0 };

/** Appends the names of the cues of one found cue event (several cues on one tick are one event), but `except`'s. */
function pushCueNames(to: string[], f: Found, except: number): void {
  const g = f.grid;
  if (!g || f.cue < 0) return;
  for (let i = f.cueFirst; i <= f.cue; i++) if (i !== except && g.cueTicks[i] === f.ticks) to.push(g.cueNames[i]!);
}

/**
 * K1: the due event of `kind` for this dispatch (heard time < `now` + `frameIntervalSeconds`, past the cursor), written
 * into `out` with `missed` and `skippedCues` filled, and the cursor advanced. False when none is due.
 *
 * `out.handle` is the caller's (K2 sets it); every other field is written. `heardIn` is `time - now`: in [0, Δ̄) for an
 * on-time call, negative when the frame came late (a hitch, a hidden tab). `counters.missedBeats` counts the beats
 * coalesced. `frameIntervalSeconds` is Δ̄ (`planner.ts` `frameIntervalSeconds(f)`).
 */
export function predictDue(player: MusicPlayer, kind: MusicKind, now: number, frameIntervalSeconds: number, out: MusicEvent): boolean {
  if (!Number.isFinite(now)) return false;
  resyncBeats(player, now);
  const st = player.beats!;
  if (st.held || !sources(player, st)) return false;
  const cur = st[kind];
  const limit = now + (frameIntervalSeconds > 0 ? frameIntervalSeconds : 0);
  let n = 0;
  let t = cur.time;
  let skipped: string[] | undefined;
  let firstNew: SegmentRun | null = null;
  let firstNewTime = Number.NaN;
  while (n < MAX_WALK && nextEvent(kind, t) && found.time < limit) {
    if (n > 0 && kind === "cue") pushCueNames((skipped ??= []), last, -1); // the earlier cue events coalesce away
    if (firstNew === null && found.run !== cur.run) {
      firstNew = found.run;
      firstNewTime = found.time;
    }
    copyFound(last, found);
    t = found.time;
    n++;
  }
  if (n === 0) return false;
  // A recovery's re-entry: the gap's events (on the lost run's timeline) coalesce into the first call after it.
  const lost = st.lostRun;
  const gap = lost && cur.run === lost && firstNew && firstNew !== lost && firstNew.node === lost.node
    ? gapEvents(st, kind, cur.time, firstNewTime) : 0;
  const g = last.grid!;
  const c = last.ticks;
  ticksToPosition(g, c, pos);
  const span = spanAtTicks(g, c);
  out.segment = last.run!.node.id;
  out.bar = pos.bar;
  out.beat = pos.beat;
  out.tempo = g.bpm[span] ?? 0;
  out.beatsPerBar = g.beatsPerBar[span] ?? 0;
  out.time = last.time;
  out.heardIn = last.time - now;
  if (kind === "cue") {
    if (last.cue !== last.cueFirst) pushCueNames((skipped ??= []), last, last.cue); // the other cues on its tick
    out.cue = g.cueNames[last.cue];
    out.missed = (skipped?.length ?? 0) + gap;
    out.skippedCues = skipped && skipped.length > 0 ? skipped : undefined;
  } else {
    out.missed = n - 1 + gap;
    out.cue = undefined;
    out.skippedCues = undefined;
  }
  if (kind === "beat") player.counters.missedBeats += out.missed;
  cur.last = Math.max(cur.last, -1) + 1 + out.missed;
  cur.time = last.time;
  cur.run = last.run;
  cur.startAt = last.run!.startAt;
  return true;
}
