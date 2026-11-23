/**
 * The musical clock of the playlist runtime (ADR 0343 "Runtime structure"): where Switch rules timed to `beat`, `bar` or
 * `exit`, stingers and `handle.music` ask for musical boundaries and positions.
 *
 * The clock is the **playing entry's**: a Sequence with a tempo answers on its playhead (`sequence.ts`), a Clip whose
 * sample has a tempo (`sample.tempo` with its tempo map) answers on its voice's heard position (`voiceMusical.ts`, the
 * music runtime's pass walk keyed on the voice). Containers pass the question to the entry that plays (`LiveNode.
 * musicalSource`). Grid maths is the music runtime's (`engine/audio/musicGrid.ts`). `exit` waits for the next Exit marker
 * in a playing sample (or a sequence `exit` marker), else that sample's loop end; with no tempo `beat` and `bar` have no
 * boundary and the change happens at once (the Studio lints it).
 */
import type { GridSpec, MusicSeekResult } from "../../../../engine/audio/musicTypes";

/** A musical boundary a change can wait for. */
export type MusicalBoundary = "beat" | "bar" | "exit";

export interface MusicalClock {
  /**
   * The heard time (seconds) of the next `kind` boundary at or after `from` in the playing entry, or null when there is
   * none to wait for (no tempo, nothing playing, no Exit marker or loop ahead).
   */
  nextBoundary(kind: MusicalBoundary, from: number): number | null;
  /** Seconds per beat of the playing entry now, null when it has no tempo. */
  secondsPerBeat(): number | null;
}

/** A musical position (1-based bar and beat), as `handle.music` reads it. */
export interface MusicalPosition {
  bar: number;
  beat: number;
  /** 0..1 through the beat. */
  beatFraction: number;
  tempo: number;
  beatsPerBar: number;
  beatUnit: number;
}

/** A playing entry with a musical clock: a Sequence with a tempo, or a Clip whose sample has one. */
export interface MusicalSource extends MusicalClock {
  /** What `handle.music.segment` names: the playlist path (a sequence) or the sample path (a clip). */
  readonly label: string;
  /** Whether it has a tempo (beats and bars); one without answers `exit` only. */
  readonly hasGrid: boolean;
  /** The position heard at `time`, null when it plays nothing then or has no tempo. */
  positionAt(time: number): MusicalPosition | null;
  /** The next grid point of `spec` at or after heard `from`, null when none. */
  nextGrid(spec: GridSpec, from: number): { time: number; bar: number; beat: number } | null;
  /** Jump to `"bar:beat:tick"`; sources that can't seek refuse. */
  seek(to: string): MusicSeekResult;
}

/** No boundaries, no tempo (nothing playing with a musical clock). */
export const NO_MUSICAL_CLOCK: MusicalClock = Object.freeze({
  nextBoundary: () => null,
  secondsPerBeat: () => null,
});

/** The clock over whatever source plays now (asked each time: the playing entry changes). */
export function clockOver(source: () => MusicalSource | null): MusicalClock {
  return {
    nextBoundary: (kind, from) => source()?.nextBoundary(kind, from) ?? null,
    secondsPerBeat: () => source()?.secondsPerBeat() ?? null,
  };
}

/** A beat when the playing entry has no tempo: the prototype's fixed 500 ms (120 BPM). */
export const FALLBACK_SECONDS_PER_BEAT = 0.5;

/** The note for a timed change acted on at once. */
export const MUSICAL_FALLBACK_NOTE = "has no boundary to wait for (the playing entry has no tempo, Exit marker or loop); it changes now";
