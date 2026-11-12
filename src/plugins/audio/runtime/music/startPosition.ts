/**
 * F-41 (@internal, the editor transport): start the music's first segment at a position instead of at the file's start,
 * so "play from a cue or bar" starts there once, instead of starting at the start and seeking a moment later (which
 * restarted the playhead audibly). `editorHooks.startAtPosition` records the position; `requestStart` reads it for the
 * first start only, and the planner's `startFrameAt` keeps it right if the clip's facts arrive later.
 */
import type { SegmentNode } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid, positionInMetre, positionToTicks, secondsToFrames, ticksToSeconds } from "../../../../engine/audio/musicGrid";
import { MAX_POSITION_BAR, MAX_POSITION_BEAT, MUSIC_TICKS_PER_BEAT } from "../../../../engine/audio/musicPosition";
import type { MusicPlayer } from "./musicSystem";
import type { PlanRequest } from "./planner";
import { segmentClipSource } from "./segmentRun";

const FALLBACK_RATE = 48_000;
const SHAPE = /^(\d+)(?::(\d+)(?::(\d+))?)?$/;

/** The position text each player is to start at; read by the first start. */
export const startPositions = new WeakMap<MusicPlayer, string>();

/** File seconds of `to` (`"bar:beat:tick"`) in `segment`, clamped to the file, and its start frame; null when it isn't a position of the segment. */
export function startSeconds(segment: SegmentNode, to: string): { seconds: number; frame: () => number } | null {
  const m = SHAPE.exec(to);
  if (m === null || !Array.isArray(segment.tempo)) return null;
  const bar = Number(m[1]);
  const beat = m[2] === undefined ? 1 : Number(m[2]);
  const tick = m[3] === undefined ? 0 : Number(m[3]);
  if (bar < 1 || bar > MAX_POSITION_BAR || beat < 1 || beat > MAX_POSITION_BEAT || tick < 0 || tick >= MUSIC_TICKS_PER_BEAT) return null;
  const clip = segment.tracks.find((t) => t.clip)?.clip;
  const facts = () => {
    const f = clip ? segmentClipSource().facts(clip) : undefined;
    return f && f.rate > 0 ? f : undefined;
  };
  const f0 = facts();
  const grid = compileSegmentGrid({ ...segment, cues: segment.cues ?? [] }, f0 ? { endSeconds: f0.frames / f0.rate } : {});
  if (!positionInMetre(grid, bar, beat)) return null;
  let seconds = ticksToSeconds(grid, positionToTicks(grid, bar, beat, tick));
  if (Number.isFinite(grid.endSeconds)) seconds = Math.min(seconds, grid.endSeconds);
  seconds = Math.max(0, seconds);
  const frame = (): number => {
    const f = facts();
    let n = secondsToFrames(seconds, f?.rate ?? FALLBACK_RATE);
    if (f && f.frames > 0) n = Math.min(n, f.frames - 1);
    return n;
  };
  return { seconds, frame };
}

/** `req` for the player's first start, moved to its recorded position; `req` itself when none is recorded or it doesn't fit. */
export function withStartPosition(player: MusicPlayer, req: PlanRequest): PlanRequest {
  const to = startPositions.get(player);
  if (to === undefined || req.to.type !== "segment") return req;
  const at = startSeconds(req.to as unknown as SegmentNode, to);
  if (!at) return req;
  // The lead-in before the entry cue shrinks by what the start skips; a start at the file's start is the plain start.
  const preEntry = Math.max(0, (req.preEntry ?? 0) - at.seconds);
  return { ...req, startFrame: at.frame(), startFrameAt: () => at.frame(), preEntry };
}
