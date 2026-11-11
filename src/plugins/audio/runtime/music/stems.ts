/**
 * Stems of a playing segment (ADR 0166 api-and-models §2.3 tracks, §10 P5 and R6; architecture §2.3 ring release).
 *
 * Owners: **P5** (W4) fills the ring release and solo gain; **R6** (W6) fills `quantizedRamp` (the `quantize` key on
 * automation bindings: a stamped in-voice ramp at the next grid point; it also edits `events/automation.ts`). Q2 wrote
 * the skeleton. Per-stem automation itself is 0158's.
 */
import type { GridSpec } from "../../../../engine/audio/musicTypes";
import type { MusicFrame, MusicPlayer } from "./musicSystem";
import type { SegmentRun, StemRun } from "./segmentRun";

/** Per-stem silence bookkeeping: the heard time its gain reaches 0 (solo's fade), absent while audible. */
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

function setStemGain(stem: StemRun, to: number, seconds: number, f: MusicFrame): void {
  const v = stem.voice;
  if (!v || !voiceAlive(stem)) return;
  v.fade(to, seconds);
  if (to <= 0) silentAt.set(stem, f.now + seconds);
  else silentAt.delete(stem);
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
    setStemGain(stem, state.track === null || stem.track === state.track ? 1 : 0, seconds, f);
  }
}

/**
 * R6: an automation binding with `quantize` (`beat` or `bar`) moves a stem's gain at the next grid point of `grid` as a
 * stamped in-voice ramp (sample-exact on the line). Returns the heard time it lands, NaN when not playing.
 */
export function quantizedRamp(player: MusicPlayer, track: string, to: number, grid: GridSpec, seconds: number, f: MusicFrame): number {
  void player;
  void track;
  void to;
  void grid;
  void seconds;
  void f;
  return Number.NaN; // STUB(R6)
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
        setStemGain(stem, stem.track === solo.track ? 1 : 0, 0, f);
      }
    }
    for (const stem of run.stems) releaseSilentRing(stem, f);
  }
  // Ending runs keep their stems' voices until the core reports their ends: release the silent ones' references too.
  for (const run of [player.run, player.next]) if (run && run.state === "ending") for (const stem of run.stems) releaseSilentRing(stem, f);
}
