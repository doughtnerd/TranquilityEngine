/**
 * Stems of a playing segment (ADR 0166 api-and-models §2.3 tracks, §10 P5 and R6; architecture §2.3 ring release).
 *
 * Owners: **P5** (W4) wrote the ring release and solo; **R6** (W6) wrote `quantizedRamp` (the `quantize` key on automation
 * bindings: a stamped in-voice ramp at the next grid point; it also edits `events/automation.ts`). Q2 wrote the skeleton.
 * Per-stem automation itself is 0158's.
 *
 * **Gain composition (F-6, ADR 0167 §2).** A stem's `gain` ramp (a stamped SET_PARAMS gain ramp, never the voice's `fade`
 * ramp, which crossfades own) carries `auto × solo`: `auto` is the quantised automation's level, `solo` is 1 or 0. Each
 * change re-sends the product, so a solo during a crossfade or a quantised ramp fights neither. A backend whose voice has
 * no `paramsShaped` (the Babylon fallback, the fake) gets the product on `fade` and quantised levels committed at the
 * first display frame at or after the grid point; that is the only case where `fade` carries stem gain.
 */
import { compileSegmentGrid, nextGridSeconds, ticksToSeconds, type SegmentGrid } from "../../../../engine/audio/musicGrid";
import type { GridSpec } from "../../../../engine/audio/musicTypes";
import type { SegmentNode } from "../../../../engine/audio/musicFormat";
import type { AudioVoice, FadeLaw } from "../backend";
import type { MusicFrame, MusicPlayer } from "./musicSystem";
import { segmentClipSource, type SegmentRun, type StemRun } from "./segmentRun";

/**
 * R6: what a stem's in-voice ramp asks of a voice (a stamped SET_PARAMS: `gain` is a multiplier on the voice's own dry
 * gain, `lowpassHz` a cutoff; `at` the heard time it starts, omitted: as soon as possible). `AudioVoice.paramsShaped` is
 * the backend's side (coordinator: `backend.ts`, `coreBackend.ts` -> `musicOps`); until it is there, `RampVoice` names it.
 */
export interface StampedRamp {
  gain?: number;
  lowpassHz?: number;
  seconds: number;
  law?: FadeLaw;
  at?: number;
}
export type RampVoice = AudioVoice & { paramsShaped?(r: StampedRamp): void };

/** One stem's gain parts. `auto` is in effect now; `next` is a quantised level waiting for its grid point. */
interface StemGain {
  auto: number;
  solo: number;
  next: { to: number; at: number; seconds: number; stamped: boolean } | null;
}
const gains = new WeakMap<StemRun, StemGain>();
function gainOf(stem: StemRun): StemGain {
  let g = gains.get(stem);
  if (!g) gains.set(stem, (g = { auto: 1, solo: 1, next: null }));
  return g;
}

/** Per-stem silence bookkeeping: the heard time its gain reaches 0 (solo's or automation's ramp), absent while audible. */
const silentAt = new WeakMap<StemRun, number>();
/** Per-player solo: the soloed track (null none) and the stems it has been applied to. */
const solos = new WeakMap<MusicPlayer, { track: string | null; applied: WeakSet<StemRun> }>();

function voiceAlive(stem: StemRun): boolean {
  const v = stem.voice;
  return v !== null && (v.alive ?? v.playing);
}

/**
 * P5: a stem that is silent (its gain at 0 for its fade) returns its ring when its voice ends; true when released.
 * The ring itself returns in the backend's `memberFreed` when the core reports the voice's end (architecture §2.3); this
 * drops the run's reference to the dead voice, once, for a streamed stem that was silent. Audible stems and voices still
 * alive are untouched.
 */
export function releaseSilentRing(stem: StemRun, f: MusicFrame): boolean {
  if (!stem.streamed || stem.voice === null) return false;
  const at = silentAt.get(stem);
  if (at === undefined || f.now < at || voiceAlive(stem)) return false;
  stem.voice = null;
  silentAt.delete(stem);
  return true;
}

/** Send the stem's gain (`auto × solo`) over `seconds`, starting at heard `at` when the voice can stamp it. */
function sendStemGain(stem: StemRun, auto: number, seconds: number, now: number, at?: number): void {
  const v = stem.voice as RampVoice | null;
  if (!v || !voiceAlive(stem)) return;
  const to = auto * gainOf(stem).solo;
  if (v.paramsShaped) v.paramsShaped({ gain: to, seconds, law: "linear", ...(at !== undefined ? { at } : {}) });
  else v.fade(to, seconds);
  if (to <= 0) silentAt.set(stem, (at ?? now) + seconds);
  else silentAt.delete(stem);
}

/** A solo change: send `auto × solo` now, and re-stamp a quantised ramp still waiting so it carries the new solo. */
function setStemGain(stem: StemRun, seconds: number, f: MusicFrame): void {
  const g = gainOf(stem);
  sendStemGain(stem, g.auto, seconds, f.now);
  const n = g.next;
  if (n && n.stamped && f.now < n.at) sendStemGain(stem, n.to, n.seconds, f.now, n.at);
}

function liveRuns(player: MusicPlayer): SegmentRun[] {
  const out: SegmentRun[] = [];
  for (const r of [player.run, player.next]) if (r && (r.state === "stamped" || r.state === "playing")) out.push(r);
  return out;
}

/** P5: solo one stem (others to 0 with a fade), or clear the solo with null. */
export function soloStem(player: MusicPlayer, track: string | null, fadeSeconds: number): void {
  const seconds = Math.max(0, Number.isFinite(fadeSeconds) ? fadeSeconds : 0);
  const state = solos.get(player) ?? { track: null, applied: new WeakSet<StemRun>() };
  solos.set(player, state);
  state.track = track;
  state.applied = new WeakSet<StemRun>();
  for (const run of liveRuns(player)) applySolo(run, state, seconds, lastNow.get(player) ?? 0);
}

/** The heard time of the player's last tick (`soloStem` has no frame; solo is audition-grade, so one tick stale is fine). */
const lastNow = new WeakMap<MusicPlayer, number>();

function applySolo(run: SegmentRun, state: { track: string | null; applied: WeakSet<StemRun> }, seconds: number, now: number): void {
  const f = { now } as MusicFrame;
  for (const stem of run.stems) {
    state.applied.add(stem);
    gainOf(stem).solo = state.track === null || stem.track === state.track ? 1 : 0;
    setStemGain(stem, seconds, f);
  }
}

// --- R6: quantised automation ---------------------------------------------------------------------------------------

const grids = new WeakMap<object, SegmentGrid>();
const FALLBACK_RATE = 48_000;

/**
 * Heard time of the first `grid` point at or after `from` on the playing run, NaN when unknown. The run's position comes
 * from the player's anchor when it is for this segment (P3), else from the run's own stamp: the group starts `startFrame`
 * frames into the file at `startAt`. First pass only: a loop wrap re-anchors (P3), and a point past the loop's end is
 * not heard this pass (R4b re-asks after the wrap).
 */
function nextGridHeard(player: MusicPlayer, run: SegmentRun, grid: GridSpec, from: number): number {
  const node = run.node as unknown as SegmentNode;
  let map = grids.get(node);
  if (!map) grids.set(node, (map = compileSegmentGrid(node)));
  const a = player.anchor;
  let anchorFile: number, anchorTime: number;
  if (a && a.segment === run.node.id && Number.isFinite(a.time)) {
    anchorFile = ticksToSeconds(map, a.ticks);
    anchorTime = a.time;
  } else {
    if (!Number.isFinite(run.startAt)) return Number.NaN;
    const clip = run.stems[0]?.clip;
    const rate = (clip !== undefined ? segmentClipSource().facts(clip)?.rate : undefined) || FALLBACK_RATE;
    anchorFile = run.startFrame / rate;
    anchorTime = run.startAt;
  }
  // File seconds heard at `from` (before the group starts: its start), then the grid's next point, back to heard time.
  const fileFrom = Math.max(anchorFile, anchorFile + (from - anchorTime));
  const point = nextGridSeconds(map, fileFrom, grid);
  return Number.isFinite(point) ? anchorTime + (point - anchorFile) : Number.NaN;
}

/**
 * R6: an automation binding with `quantize` (`beat` or `bar`) moves a stem's gain at the next grid point of `grid` as a
 * stamped in-voice ramp (sample-exact on the line). Returns the heard time it lands, NaN when not playing.
 *
 * `to` is the stem's automation level (the curve's gain at the parameter now, `evaluateQuantized`); it takes effect at
 * the first grid point not before `Audio.horizon` (a stamp nearer than that would not be exact), starts there, and runs
 * `seconds` (`QUANTIZED_RAMP_SECONDS`, 20 ms). Solo composes: the ramp carries `to × solo`. A later call before that
 * point replaces the level (latest wins; the two stamped records share a frame and apply in order). A level of 0 sets
 * `silentAt` to the end of the ramp so P5's ring release sees the stem. The playing run's stems are the target; the
 * successor's are not (no heard position yet).
 */
export function quantizedRamp(player: MusicPlayer, track: string, to: number, grid: GridSpec, seconds: number, f: MusicFrame): number {
  const run = player.run;
  if (!run || (run.state !== "playing" && run.state !== "stamped") || !Number.isFinite(to)) return Number.NaN;
  const stem = run.stems.find((s) => s.track === track);
  if (!stem || !stem.voice || !voiceAlive(stem)) return Number.NaN;
  const dur = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const level = Math.min(4, Math.max(0, to));
  const horizon = Math.max(f.now, f.backend.horizon?.() ?? f.now);
  const at = nextGridHeard(player, run, grid, horizon);
  if (!Number.isFinite(at)) return Number.NaN;
  const g = gainOf(stem);
  const stamped = typeof (stem.voice as RampVoice).paramsShaped === "function";
  g.next = { to: level, at, seconds: dur, stamped };
  if (stamped) sendStemGain(stem, level, dur, f.now, at);
  else if (level * g.solo <= 0) silentAt.set(stem, at + dur);
  else silentAt.delete(stem);
  return at;
}

/** R6: a quantised level whose grid point has come becomes the stem's level; on a voice that can't stamp it is sent now. */
function commitDueRamp(stem: StemRun, f: MusicFrame): void {
  const g = gains.get(stem);
  const n = g?.next;
  if (!g || !n || f.now < n.at) return;
  g.next = null;
  g.auto = n.to;
  if (!n.stamped) sendStemGain(stem, n.to, n.seconds, f.now);
}

/** P5, R6, step 9: release silent stems' rings, commit due quantised ramps. */
export function tickStems(player: MusicPlayer, f: MusicFrame): void {
  lastNow.set(player, f.now);
  const solo = solos.get(player);
  for (const run of liveRuns(player)) {
    // A run stamped after the solo was set (the next segment) takes it at once.
    if (solo && solo.track !== null) {
      for (const stem of run.stems) {
        if (solo.applied.has(stem) || !voiceAlive(stem)) continue;
        solo.applied.add(stem);
        gainOf(stem).solo = stem.track === solo.track ? 1 : 0;
        setStemGain(stem, 0, f);
      }
    }
    for (const stem of run.stems) {
      commitDueRamp(stem, f);
      releaseSilentRing(stem, f);
    }
  }
  // Ending runs keep their stems' voices until the core reports their ends: release the silent ones' references too.
  for (const run of [player.run, player.next]) if (run && run.state === "ending") for (const stem of run.stems) releaseSilentRing(stem, f);
}
