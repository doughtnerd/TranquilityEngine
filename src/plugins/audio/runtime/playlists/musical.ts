/**
 * The musical clock seam of the playlist runtime (ADR 0329 "Runtime structure"): where Switch rules timed to `beat`,
 * `bar` or `exit`, sequences with a tempo and stingers ask for musical boundaries. M5 implements it over the music
 * scheduler (`runtime/music/`: planner, grid, anchors); until then the runtime holds `NO_MUSICAL_CLOCK`, which knows no
 * boundary, so a timed change happens at once with one warning naming M5.
 */

/** A musical boundary a change can wait for. */
export type MusicalBoundary = "beat" | "bar" | "exit";

export interface MusicalClock {
  /**
   * The heard time (seconds) of the next `kind` boundary at or after `from` in the instance's playing entry (its
   * sequence's tempo, else its sync sample's tempo; `exit`: the next Exit marker, else the sample's loop end), or null
   * when there is none to wait for (no tempo, nothing playing, or no clock yet).
   */
  nextBoundary(kind: MusicalBoundary, from: number): number | null;
  /** Seconds per beat of the playing entry, null when it has no tempo. */
  secondsPerBeat(): number | null;
}

/** The clock until M5: no boundaries, no tempo. */
export const NO_MUSICAL_CLOCK: MusicalClock = Object.freeze({
  nextBoundary: () => null,
  secondsPerBeat: () => null,
});

/** A beat when the playing entry has no tempo: the prototype's fixed 500 ms (120 BPM). */
export const FALLBACK_SECONDS_PER_BEAT = 0.5;

/** The M4 note for a timed change acted on at once. */
export const MUSICAL_FALLBACK_NOTE = "waits for a musical clock, which arrives with sequences in M5; it changes now";
