// ADR 0158 §4: a clip's loop points, wherever they come from. Contract C1 of the M2 build plan
// (docs/plans/2026-11-audio-events-m2-waves.md): the signatures are final; E4.2 fills the bodies and E4.5 makes plain
// looping clips use them.
//
// Precedence: a clip's sidecar (`loopStart`/`loopEnd` seconds in `<clip>.meta.json`, ADR 0040) wins over the file's own
// points (WAV `smpl`, Ogg/Opus `LOOPSTART`/`LOOPLENGTH`). Until E4.5, only an event's `loopRegion`/`sustain` asks for
// them; a plain looping `AudioSource` keeps looping the whole clip.

/** A loop region in seconds; `end` is exclusive. */
export interface LoopPoints {
  readonly start: number;
  readonly end: number;
}

/** The clip's loop points (sidecar over file), or null when it has none or they aren't known yet. */
export function loopPointsFor(path: string): LoopPoints | null {
  void path; // E4.2
  return null;
}

/** Records the points the decoder (core path) or the TypeScript reader (Babylon path) found in the file at `path`. */
export function setFileLoopPoints(path: string, points: LoopPoints | null): void {
  void path; void points; // E4.2
}

/**
 * Calls `cb` once when `path`'s loop points become known (at once if they already are); points arrive asynchronously
 * from the decoder, so they are usually unknown at PLAY. Returns an unsubscribe function.
 */
export function onLoopPoints(path: string, cb: (points: LoopPoints | null) => void): () => void {
  void path; void cb; // E4.2
  return () => {};
}
