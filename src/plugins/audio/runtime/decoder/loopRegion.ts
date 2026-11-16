// The loop region rule of a looping stream (ADR 0158 E4.4): what the decoder worker's stream loops, from the region a
// play sends, the file's own loop points and the file's length. Pure; the worker's stream table calls it on open, seek
// and a loop change.

/** A loop region in file frames, `end` exclusive (0: the file's end). */
export interface StreamRegion {
  readonly start: number;
  readonly end: number;
}

/**
 * The region a looping stream loops (E4.4): `start`/`end` as sent (end 0 = the file's end; both absent: the file's own
 * points, `fileLoop`, else the whole file), clamped to a file of `frames` frames (-1 unknown). An empty or inverted
 * region loops the whole file, as the core does for clips.
 */
export function resolveRegion(start: number | undefined, end: number | undefined, fileLoop: StreamRegion | null, frames: number): StreamRegion {
  if (start === undefined && end === undefined) return fileLoop ?? { start: 0, end: 0 };
  let a = Math.max(0, Math.floor(start ?? 0));
  let b = Math.max(0, Math.floor(end ?? 0));
  if (frames > 0 && (b === 0 || b > frames)) b = frames;
  if (b !== 0 && !(a < b)) {
    a = 0;
    b = frames > 0 ? frames : 0;
  }
  return { start: a, end: b };
}
