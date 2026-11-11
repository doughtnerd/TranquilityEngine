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
 */
import type { MusicSeekResult } from "../../../../engine/audio/musicTypes";
import type { MusicPlayer } from "./musicSystem";

/** The crossfade of a seek, milliseconds (§10 R7). */
export const SEEK_FADE_MS = 5;

/** A position `"bar:beat:tick"` (§2.2), 1-based bar and beat, tick 0-based; null when it doesn't parse. */
export interface SeekPosition {
  bar: number;
  beat: number;
  tick: number;
}

/** R7: parse `"bar:beat:tick"` (`"bar:beat"` and `"bar"` too, the rest 1 and 0); null when invalid. */
export function parseSeekPosition(to: string): SeekPosition | null {
  void to;
  return null; // STUB(R7)
}

/**
 * R7: `handle.music.seek(to)`. An invalid position returns `{ ok: false, reason: "invalid", permanent: true }`; music
 * that isn't playing `notPlaying` (permanent); a group that never fits `neverFits` (permanent); no free rings now
 * `poolFull` (temporary, retried each display frame until the target changes).
 */
export function seekMusic(player: MusicPlayer, to: string): MusicSeekResult {
  void player;
  void to;
  return { ok: false, reason: "notPlaying", permanent: true }; // STUB(R7)
}
