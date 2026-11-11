/**
 * Stingers and `handle.trigger` (ADR 0166 api-and-models §1.2 `trigger`, §2.5; architecture §3.4).
 *
 * Owner: **R5** (W6), with the pure decision table in `stingerPolicy.ts` (leaf L-R5a). Q2 wrote the skeleton.
 *
 * `trigger` names are one namespace per event; with several matches the deepest container above the playing segment
 * wins, then list order. A stinger is quantised to its `at` (a `GridSpec`, `immediate` or the next `{cue}`), honours
 * `dontRepeat` and `ifTooLate`, plays on its own voices and bus over the music, never changes the grid, and at most 4
 * sound at once per instance (the fifth steals the oldest with a 5 ms fade). A refused stinger is dropped.
 *
 * **Flow.** `triggerStinger` resolves the name, quantises `at` against the playing segment's anchor, asks
 * `decideStinger` (`dontRepeat`, `ifTooLate`), and admits and primes the stinger's segment as its own run (a decoded
 * stinger is ungated single voices; a streamed one is a group), all at trigger time so the answer is the truth. It
 * queues the run. `tickStingers` (step 9) stamps a primed run at its point: a streamed stinger that finds its point
 * inside its prime lead goes through `decideStinger` again, so `ifTooLate` applies exactly where §3.4 says. A stinger
 * never writes `player.run`, `player.anchor` or `player.planned`: the grid is the music's alone.
 *
 * `triggerStinger(player, name)` has no frame argument, so it reads the last frame `tickStingers` saw (the frame object
 * is the music system's one reused object; `backend.time` on it is live). A trigger before the first tick is refused.
 */
import type { AudioVoice } from "../backend";
import {
  compileSegmentGrid, cueSeconds, nextGridSeconds, secondsToTicks, ticksToSeconds, type SegmentGrid,
} from "../../../../engine/audio/musicGrid";
import type { MusicContainerNode, MusicNode, SegmentNode } from "../../../../engine/audio/musicFormat";
import {
  MAX_CONCURRENT_STINGERS, resolveStinger, STINGER_STEAL_FADE_SECONDS, type StingerDef,
} from "../../../../engine/audio/musicRules";
import { warnOnce } from "../core/handle";
import { playerOf, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { cancelRun, createSegmentRun, pollPrimed, primeRun, segmentClipSource, stampRun, type SegmentRun } from "./segmentRun";
import { decideStinger } from "./stingerPolicy";

/** At most this many stingers sound at once per instance (§2.5, R20). */
export const MAX_STINGERS = MAX_CONCURRENT_STINGERS;

/** A queued stinger that is still not primed this long after its point is dropped (seconds). */
const PRIME_GIVE_UP_SECONDS = 2;

/** A stinger waiting for its grid point, or sounding. */
export interface StingerEntry {
  /** The stinger's `trigger` name. */
  readonly trigger: string;
  /** Library id of its segment. */
  readonly segment: string;
  /** Heard time (seconds) it is (or was) stamped at; NaN while not yet planned. */
  at: number;
  /** Its voices once stamped. */
  voices: AudioVoice[];
  /** The stinger's own run (admitted and primed at trigger time), and its definition. */
  readonly run: SegmentRun;
  readonly def: Readonly<StingerDef>;
  /** The quantised point after `at`, for `nextGrid` when the point has passed by stamp time; NaN: none. */
  readonly nextPoint: number;
  /** The decision found the point late (`late` counter, once, at stamp). */
  late: boolean;
}

/** The player's stinger queue and `dontRepeat` stamps. R5 may add fields here. */
export interface StingerState {
  readonly queued: StingerEntry[];
  readonly sounding: StingerEntry[];
  /** Trigger name → heard time (seconds) it last played, for `dontRepeat`. */
  readonly lastPlayed: Map<string, number>;
}

/** R5: an empty stinger state. */
export function createStingerState(): StingerState {
  return { queued: [], sounding: [], lastPlayed: new Map() };
}

/** The last frame `tickStingers` saw (see the header). */
let lastFrame: MusicFrame | null = null;

/** @internal Tests: forget the remembered frame and the compiled grids. */
export function _resetStingers(): void {
  lastFrame = null;
}

const alive = (v: AudioVoice): boolean => v.alive ?? v.playing;

function bump(player: MusicPlayer, cause: string): void {
  player.counters.refusals[cause] = (player.counters.refusals[cause] ?? 0) + 1;
}

/** The containers above `id` in `root`, outermost first; null when `id` is not in the tree. */
function containersAbove(root: MusicNode, id: string): MusicContainerNode[] | null {
  const chain: MusicContainerNode[] = [];
  const walk = (n: MusicNode): boolean => {
    if (n.id === id) return true;
    const kids = (n as Partial<MusicContainerNode>).children;
    if (!Array.isArray(kids)) return false;
    chain.push(n as MusicContainerNode);
    for (const k of kids) if (walk(k)) return true;
    chain.pop();
    return false;
  };
  return walk(root) ? chain : null;
}

/** The playing segment's compiled grid, cached per node (recompiled when the clip length becomes known). */
const grids = new WeakMap<object, { end: number; grid: SegmentGrid }>();
function gridOf(node: SegmentNode): SegmentGrid {
  let end = Number.NaN;
  const clip = node.tracks.find((t) => t.clip)?.clip;
  const facts = clip ? segmentClipSource().facts(clip) : undefined;
  if (facts && facts.rate > 0) end = facts.frames / facts.rate;
  const hit = grids.get(node);
  if (hit && (hit.end === end || (Number.isNaN(hit.end) && Number.isNaN(end)))) return hit.grid;
  const grid = compileSegmentGrid(node, Number.isNaN(end) ? {} : { endSeconds: end });
  grids.set(node, { end, grid });
  return grid;
}

/** The stinger's segment with its own volume and bus applied to every track (`groupRequest` reads them from the node). */
function withOwn(segment: SegmentNode, def: Readonly<StingerDef>): SegmentNode {
  if (def.volume === undefined && def.bus === undefined) return segment;
  return {
    ...segment,
    tracks: segment.tracks.map((t) => ({ ...t, volume: t.volume * (def.volume ?? 1), bus: def.bus ?? t.bus })),
  };
}

/** Earliest heard time a stinger run can start: the horizon, and for a streamed one the prime lead. */
function earliestFor(run: SegmentRun, player: MusicPlayer, f: MusicFrame): number {
  const now = f.backend.time;
  let earliest = Math.max(now, f.backend.horizon?.() ?? now);
  if (run.stems.some((s) => s.streamed)) earliest = Math.max(earliest, now + player.counters.leadMs / 1000);
  return earliest;
}

/** Stingers queued or sounding (a stamped one that has not started yet counts). */
function soundingCount(st: StingerState, now: number): number {
  let n = st.queued.length;
  for (const e of st.sounding) if (now <= e.at || e.voices.some(alive)) n++;
  return n;
}

/**
 * R5: fire the stinger whose `trigger` is `name`. True when accepted; false when unknown, dropped by `dontRepeat` or
 * `ifTooLate: "skip"`, or the pool refused it (the counters say which).
 */
export function triggerStinger(player: MusicPlayer, name: string): boolean {
  const f = lastFrame;
  const run = player.run;
  if (!f || !f.music || !run || run.state === "cancelled" || player.state === "stopping" || player.state === "stopped" || player.state === "refused") {
    bump(player, "stingerNotPlaying");
    return false;
  }
  const chain = containersAbove(player.root as MusicNode, run.node.id);
  const hit = chain ? resolveStinger(chain, name) : null;
  if (!hit) {
    bump(player, "stingerUnknown");
    return false;
  }
  const st = (player.stingers ??= createStingerState());
  const def = hit.stinger;
  const counters = player.counters.stingers;

  const own = createSegmentRun(player, withOwn(hit.segment, def), 0);
  if (!own) {
    bump(player, "stingerNoStems");
    return false;
  }
  const now = f.backend.time;
  const earliest = earliestFor(own, player, f);

  // Quantise `at` against the playing segment's anchor (heard seconds). No anchor: only "immediate" has a point.
  let point = Number.NaN;
  let nextPoint = Number.NaN;
  if (def.at === "immediate") {
    point = earliest;
  } else if (player.anchor && player.anchor.segment === run.node.id) {
    const grid = gridOf(run.node as SegmentNode);
    const a = player.anchor;
    const anchorFile = ticksToSeconds(grid, a.ticks);
    const fileNow = anchorFile + (now - a.time);
    const heard = (file: number): number => a.time + (file - anchorFile);
    if (typeof def.at === "object" && "cue" in def.at) {
      const cue = cueSeconds(grid, def.at.cue);
      if (cue !== null && cue >= fileNow - 1e-9) point = heard(cue);
    } else {
      const file = nextGridSeconds(grid, fileNow, def.at);
      point = heard(file);
      const after = ticksToSeconds(grid, Math.round(secondsToTicks(grid, file)) + 1);
      nextPoint = heard(nextGridSeconds(grid, after, def.at));
    }
  }

  const last = st.lastPlayed.get(def.trigger);
  const d = decideStinger({
    now, earliest, point, nextPoint, ifTooLate: def.ifTooLate, dontRepeat: def.dontRepeat,
    lastPlayed: last === undefined ? Number.NaN : last, sounding: soundingCount(st, now),
  });
  if (!d.play) {
    if (d.reason === "skip") counters.skipped++;
    else counters.dropped++;
    return false;
  }
  if (d.late && def.ifTooLate === "nextGrid") {
    warnOnce(`stinger:late:${player.instance.path}:${def.trigger}`, `Stinger "${def.trigger}" was triggered too late for its point and moved to the next grid point (ifTooLate: "nextGrid").`);
  }
  if (!primeRun(player, own, f)) {
    bump(player, "poolFull");
    counters.dropped++;
    return false;
  }
  st.lastPlayed.set(def.trigger, d.at);
  st.queued.push({ trigger: def.trigger, segment: hit.segment.id, at: d.at, voices: [], run: own, def, nextPoint, late: d.late });
  return true;
}

/** `handle.trigger(name)` on any event handle (`Audio.ts`): false for a non-music handle. */
export function triggerOn(instance: object, name: string): boolean {
  const p = playerOf(instance);
  return p !== null && triggerStinger(p, name);
}

/** The oldest sounding stinger is stolen: its voices fade over 5 ms from `at`. */
function steal(st: StingerState, at: number): void {
  const old = st.sounding.shift();
  if (!old) return;
  for (const v of old.voices) {
    if (v.fadeShaped) v.fadeShaped({ to: 0, seconds: STINGER_STEAL_FADE_SECONDS, law: "linear", at, stopAtEnd: true });
    else v.stop(STINGER_STEAL_FADE_SECONDS);
  }
}

/** R5, step 9: plan and stamp queued stingers at their grid points; forget ended ones. */
export function tickStingers(player: MusicPlayer, f: MusicFrame): void {
  lastFrame = f;
  const st = player.stingers;
  if (!st) return;
  const now = f.backend.time;
  const counters = player.counters.stingers;
  const over = player.state === "stopping" || player.state === "stopped" || player.state === "refused";

  // Queued: stamp once primed, deciding again when the point slipped inside the lead.
  for (let k = 0; k < st.queued.length; k++) {
    const e = st.queued[k]!;
    let drop = over || e.run.state === "cancelled";
    if (!drop && pollPrimed(e.run, f)) {
      const earliest = earliestFor(e.run, player, f);
      const d = decideStinger({
        now, earliest, point: e.at, nextPoint: e.nextPoint, ifTooLate: e.def.ifTooLate, dontRepeat: 0,
        lastPlayed: Number.NaN, sounding: 0,
      });
      if (!d.play) {
        if (d.reason === "skip") counters.skipped++;
        else counters.dropped++;
        st.queued.splice(k--, 1);
        cancelRun(e.run, f);
        continue;
      }
      st.queued.splice(k--, 1);
      while (st.sounding.length >= MAX_STINGERS) steal(st, d.at);
      stampRun(player, e.run, d.at, f);
      e.at = d.at;
      e.voices = e.run.stems.map((s) => s.voice).filter((v): v is AudioVoice => v !== null);
      st.lastPlayed.set(e.trigger, d.at);
      counters.played++;
      if (e.late || d.late) counters.late++;
      st.sounding.push(e);
      continue;
    }
    if (!drop && now > e.at + PRIME_GIVE_UP_SECONDS) drop = true;
    if (drop) {
      st.queued.splice(k--, 1);
      cancelRun(e.run, f);
      counters.dropped++;
    }
  }

  // Sounding: forget the ones that ended (their start has passed and no voice lives).
  for (let k = 0; k < st.sounding.length; k++) {
    const e = st.sounding[k]!;
    if (now <= e.at || e.voices.some(alive)) continue;
    st.sounding.splice(k--, 1);
    cancelRun(e.run, f);
  }
}
