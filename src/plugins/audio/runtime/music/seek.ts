/**
 * The public music seek `handle.music.seek(position)` (ADR 0166 api-and-models §1.2; architecture §3.9; ADR 0167 §3
 * owner decision 4; coordinator ruling R25).
 *
 * Owner: **R7** (W7), on R3a's `transition.planImmediate` (hook H5). Q2 wrote the skeleton.
 *
 * `"bar:beat:tick"` (§2.2) is read in the segment that will be playing when the seek lands; clamped to [file start,
 * segment end]; a pending change is replaced before its cancel point (T - L), else the seek is planned after T in the
 * incoming segment. Stamped like every music change, with a 5 ms crossfade. The playlist cursor, `plays`, the switch
 * value and the alternative picks are unchanged; the skipped span fires no `missed` or `skippedCues`.
 *
 * What lives here: the position's reading and clamping (against the target segment's own tempo map), the choice of the
 * segment the position is read in, and the mapping of the planner's refusals onto `MusicSeekResult`. The crossfade, the
 * stamp, the replace-or-queue rule and the landing (anchor, beat clock, regions) are `planImmediate`'s and the
 * planner's; a seek never touches the playlist cursor, the switch state or the alternative picks, so nothing here does.
 *
 * Refusals, by what a caller should do:
 * - permanent: `invalid` (the text isn't a position, names a beat the metre doesn't have, or the target has no
 *   playable track), `notPlaying` (stopping, stopped, refused or ended), `neverFits` (the segment's group can never
 *   hold two sets of rings on this preset);
 * - temporary: `poolFull` (no free rings now) and `notPlaying` while the first segment hasn't started sounding yet
 *   (the editor transport calls seek in the frame it plays). The caller retries each display frame; a temporary
 *   refusal leaves no plan behind, so a seek that is refused is a seek that did not happen.
 */
import type { MusicSeekResult } from "../../../../engine/audio/musicTypes";
import type { SegmentNode } from "../../../../engine/audio/musicFormat";
import {
  compileSegmentGrid, positionInMetre, positionToTicks, secondsToFrames, ticksToSeconds, type SegmentGrid,
} from "../../../../engine/audio/musicGrid";
import { MAX_POSITION_BAR, MAX_POSITION_BEAT, MUSIC_TICKS_PER_BEAT } from "../../../../engine/audio/musicPosition";
import { audioBackend } from "../backend";
import { playerOf, type MusicFrame, type MusicPlayer } from "./musicSystem";
import { segmentClipSource } from "./segmentRun";
import { cancelTransition, planImmediate } from "./transition";

/** The crossfade of a seek, milliseconds (§10 R7). */
export const SEEK_FADE_MS = 5;

/** A position `"bar:beat:tick"` (§2.2), 1-based bar and beat, tick 0-based; null when it doesn't parse. */
export interface SeekPosition {
  bar: number;
  beat: number;
  tick: number;
}

const SHAPE = /^(\d+)(?::(\d+)(?::(\d+))?)?$/;

/**
 * R7: parse `"bar:beat:tick"` (`"bar:beat"` and `"bar"` too, the rest 1 and 0); null when invalid. Whole numbers only
 * (no sign, space or fraction): bar 1..`MAX_POSITION_BAR`, beat 1..`MAX_POSITION_BEAT`, tick 0..959. Whether the beat
 * exists in the bar's metre is the segment's to say (`seekMusic`).
 */
export function parseSeekPosition(to: string): SeekPosition | null {
  if (typeof to !== "string") return null;
  const m = SHAPE.exec(to);
  if (m === null) return null;
  const bar = Number(m[1]);
  const beat = m[2] === undefined ? 1 : Number(m[2]);
  const tick = m[3] === undefined ? 0 : Number(m[3]);
  if (bar < 1 || bar > MAX_POSITION_BAR) return null;
  if (beat < 1 || beat > MAX_POSITION_BEAT) return null;
  if (tick < 0 || tick >= MUSIC_TICKS_PER_BEAT) return null;
  return { bar, beat, tick };
}

/** Float noise allowed when comparing heard seconds (as `transition.ts`). */
const EPS = 1e-7;
/** The clip rate when no stem has facts yet (as `transition.ts`). */
const FALLBACK_RATE = 48_000;

const invalid: MusicSeekResult = { ok: false, reason: "invalid", permanent: true };
const gone: MusicSeekResult = { ok: false, reason: "notPlaying", permanent: true };
const notYet: MusicSeekResult = { ok: false, reason: "notPlaying", permanent: false };

/** The first stem's clip facts (length and rate), or null while they are unknown. */
function factsOf(segment: SegmentNode): { frames: number; rate: number } | null {
  for (const t of segment.tracks) {
    const f = t.clip ? segmentClipSource().facts(t.clip) : undefined;
    if (f && f.rate > 0) return { frames: f.frames, rate: f.rate };
  }
  return null;
}

/** The grid a position is read on: the segment's tempo map with its file length when known. */
function gridOf(segment: SegmentNode, endSeconds: number | undefined): SegmentGrid | null {
  if (!Array.isArray(segment.tempo)) return null;
  return compileSegmentGrid({ ...segment, cues: segment.cues ?? [] }, endSeconds === undefined ? {} : { endSeconds });
}

/** True while a transition can still be replaced by a newer change (`transition.ts`'s rule). */
function replaceable(t: NonNullable<MusicPlayer["transition"]>, now: number): boolean {
  if (t.state === "pending") return true;
  return t.state === "stamped" && now < t.cancelBy - EPS;
}

/**
 * The segment a position is read in: the one that plays when the seek lands. A change before its cancel point is
 * replaced by the seek, so that is the playing segment; a committed one lands first, and the seek is planned after it,
 * in the incoming segment.
 */
function landingSegment(player: MusicPlayer, now: number): { node: SegmentNode; after: number } | null {
  const t = player.transition;
  const open = t !== null && t.state !== "done" && t.state !== "cancelled";
  if (open && !replaceable(t, now)) {
    const inc = t.incoming?.run.node;
    if (!inc || inc.type !== "segment") return null;
    return { node: inc as SegmentNode, after: t.exitAt };
  }
  const run = player.run?.node;
  return run && run.type === "segment" ? { node: run as SegmentNode, after: Number.NaN } : null;
}

/** The counter of `cause` (`refusals.*`), for telling which refusal a null `planImmediate` was. */
const refusals = (player: MusicPlayer, cause: string): number => player.counters.refusals[cause] ?? 0;

/**
 * R7: `handle.music.seek(to)`. An invalid position returns `{ ok: false, reason: "invalid", permanent: true }`; music
 * that isn't playing `notPlaying` (permanent; temporary until the first segment sounds); a group that never fits
 * `neverFits` (permanent); no free rings now `poolFull` (temporary, retried each display frame until the target changes).
 * Success carries the planned heard landing time (a seek queued behind a committed change: that change's landing T,
 * the earliest it can land).
 *
 * Only the playing item's position moves, across loop passes included. Seeking to another segment is a switch or a
 * playlist change, not a seek (ruling R25), so a position is never read in a segment other than the one playing when
 * the seek lands.
 */
export function seekMusic(player: MusicPlayer, to: string): MusicSeekResult {
  if (playerOf(player.instance) !== player) return gone;
  const s = player.state;
  if (s === "stopping" || s === "stopped" || s === "refused") return gone;
  const backend = audioBackend();
  const f: MusicFrame = { backend, music: backend.music ?? null, now: backend.time, dt: 0, hidden: false };
  const run = player.run;
  if (!run || s === "starting" || s === "waiting" || s === "committed" || run.state === "new" || run.state === "admitted" || run.state === "priming") return notYet;
  if (Number.isFinite(run.startAt) && f.now < run.startAt - EPS) return notYet;

  const pos = parseSeekPosition(to);
  if (!pos) return invalid;
  const target = landingSegment(player, f.now);
  if (!target) return invalid;
  const facts = factsOf(target.node);
  const grid = gridOf(target.node, facts ? facts.frames / facts.rate : undefined);
  if (!grid || !positionInMetre(grid, pos.bar, pos.beat)) return invalid;

  // Clamp to [file start, file end]: a position in the pickup before bar 1 is reachable only through gridOffset.
  let seconds = ticksToSeconds(grid, positionToTicks(grid, pos.bar, pos.beat, pos.tick));
  if (Number.isFinite(grid.endSeconds)) seconds = Math.min(seconds, grid.endSeconds);
  seconds = Math.max(0, seconds);
  const rate = facts?.rate ?? FALLBACK_RATE;
  let frame = secondsToFrames(seconds, rate);
  if (facts && facts.frames > 0) frame = Math.min(frame, facts.frames - 1);

  const noTrack = refusals(player, "noTrack");
  const t = planImmediate(player, target.node, frame, SEEK_FADE_MS, f);
  if (t === null) {
    // A segment with no playable track is the position's problem; any other drop is the planner's permanent refusal.
    return refusals(player, "noTrack") > noTrack ? invalid : { ok: false, reason: "neverFits", permanent: true };
  }
  const planned = t.incoming;
  if (planned && planned.status === "waiting" && planned.refusal !== null) {
    // No free rings now: drop the plan (the music plays on, any change it replaced is gone) and let the caller retry.
    cancelTransition(player, f);
    return { ok: false, reason: "poolFull", permanent: false };
  }
  return { ok: true, time: planned ? planned.point : target.after };
}
