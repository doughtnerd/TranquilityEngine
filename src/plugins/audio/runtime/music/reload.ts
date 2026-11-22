/**
 * The hot reload rule of a playing musical piece (ADR 0166 api-and-models §10 P8, kept for playlists by ADR 0329): an
 * edited Sequence swaps at the next bar, the old voices fading out over `RELOAD_FADE_MS` there, and the new version
 * continues at the same time when its tempo map is unchanged (`sameTempoMap`), else from its start. The playlist
 * runtime's Sequence applies it (`playlists/sequence.ts`); the decoded clips and the worker's encoded bytes of an edited
 * file are dropped when the asset changes (`AudioSource.ts`).
 */
import type { TempoMap } from "../../../../engine/audio/musicGrid";

/** The crossfade at the swap, milliseconds: the outgoing voices fade out from the bar line. */
export const RELOAD_FADE_MS = 5;

function sameArray(a: ArrayLike<number>, b: ArrayLike<number>, n: number): boolean {
  for (let k = 0; k < n; k++) if (a[k] !== b[k]) return false;
  return true;
}

/** The two maps put every bar and beat at the same file time. */
export function sameTempoMap(a: TempoMap, b: TempoMap): boolean {
  return a.count === b.count && a.gridOffset === b.gridOffset &&
    sameArray(a.startTick, b.startTick, a.count) && sameArray(a.bpm, b.bpm, a.count) &&
    sameArray(a.beatsPerBar, b.beatsPerBar, a.count) && sameArray(a.beatUnit, b.beatUnit, a.count);
}
