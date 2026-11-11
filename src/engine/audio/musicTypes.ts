/**
 * Interactive music (ADR 0166, amended by 0167): the public value types of `api-and-models.md` §1.1, §1.2 and §1.5.
 *
 * Contract Q0 of the M4 build plan (`docs/plans/2026-11-audio-music-m4-waves.md`). These live in the engine, not the
 * audio plugin, so `engine/core/Component.ts` can name `MusicEvent` in its lifecycle hooks (§1.4) without importing a
 * plugin (`src/plugins/plugins.test.ts`). The audio plugin's `AudioEventHandle` satisfies `MusicEventHandle`.
 *
 * Units: seconds on the heard clock (`Audio.time`'s base) unless a field says otherwise; `performanceTime` is a
 * `performance.now()` value in milliseconds (what `event.timeStamp` holds); bars and beats are 1-based.
 */

/** `"beat"`, `"bar"`, or every n-th: `{ every: "bar", n: 2 }` (n 2..64). Wwise's grid; FMOD's quantisation. */
export type GridSpec = "beat" | "bar" | { every: "beat" | "bar"; n: number };

/** The three callback kinds: `onMusicBeat`, `onMusicBar`, `onMusicCue` as component messages; `"beat" | "bar" | "cue"` for `handle.onMusic`. */
export type MusicKind = "beat" | "bar" | "cue";

/**
 * The result of `handle.music.seek`: the planned heard landing time (seconds), or a refusal. A permanent refusal
 * (invalid position or segment, not playing, never fits the pool) is final; a temporary one (no free rings) is retried
 * each display frame until the target changes.
 */
export type MusicSeekResult =
  | { ok: true; time: number }
  | { ok: false; reason: "invalid" | "notPlaying" | "neverFits" | "poolFull"; permanent: boolean };

/** A point on the music's grid, heard time in seconds. */
export interface GridPoint {
  time: number;
  bar: number;
  beat: number;
  /** Node id of the segment this point belongs to. */
  segment: string;
}

/**
 * The part of a playing event's handle that music callbacks carry (§1.2). The audio plugin's `AudioEventHandle`
 * extends this; the engine names only this shape so it never imports the plugin.
 */
export interface MusicEventHandle {
  /** True until the instance ends or is stopped. */
  readonly playing: boolean;
  /** The music state; undefined unless the event's root is a segment, playlist or musicSwitch. */
  readonly music: MusicHandle | undefined;
  /**
   * Subscribe to beat, bar or cue events of this music instance, for scripts that `Audio.play` music with no node (M4c;
   * owner decision 3). Returns an unsubscribe function. A non-music handle returns a no-op function.
   */
  onMusic(kind: MusicKind, fn: (e: MusicEvent) => void): () => void;
  /**
   * Fire the stinger whose `trigger` is `name`. True when accepted; false when unknown, dropped by `dontRepeat` or
   * `ifTooLate: "skip"`, or the pool refused it (the debug rows say which).
   */
  trigger(name: string): boolean;
}

/** What a beat, bar or cue callback carries (§1.1). Every field states its unit. */
export interface MusicEvent {
  handle: MusicEventHandle;
  /** Node id of the playing segment. */
  segment: string;
  /** 1-based integers; a bar event has beat 1. */
  bar: number;
  beat: number;
  /** `onMusicCue` only: the cue's name. */
  cue?: string;
  /** Beats per minute at this point. */
  tempo: number;
  beatsPerBar: number;
  /** Seconds: when this beat is heard, `Audio.time`'s base. */
  time: number;
  /** Seconds until it is heard: `time - Audio.time`; >= 0 unless `missed` > 0. */
  heardIn: number;
  /** Beats of this kind coalesced into this call; 0 normally. */
  missed: number;
  /** Cue events only: the names of cues coalesced away (R20). */
  skippedCues?: string[];
}

/** `handle.music.positionAt(performanceTime)` (§1.1, M4c). */
export interface MusicPositionAt {
  /** Null: the music is not playing at that instant. */
  segment: string | null;
  bar: number;
  beat: number;
  /** 0..1 through the beat. */
  beatFraction: number;
  /** Seconds: the nearest beat's heard time. */
  nearestBeatTime: number;
  /** Seconds, signed: positive means the input was late; raw, before calibration. */
  offset: number;
  /** `offset - Audio.calibration` (seconds): what a rhythm game compares. */
  judged: number;
}

/**
 * `handle.music` (§1.2): readable from M4a. Every getter is main-side state, no call to the core; the getters share one
 * snapshot per display frame, recomputed on first read.
 */
export interface MusicHandle {
  /** Id of the playing segment; null while priming the first one. */
  readonly segment: string | null;
  readonly bar: number;
  readonly beat: number;
  readonly beatFraction: number;
  /** Beats per minute. */
  readonly tempo: number;
  readonly beatsPerBar: number;
  /** The metre's note value (4 in 3/4). */
  readonly beatUnit: number;
  /** Heard time (seconds) of the position above: this display frame's `Audio.time`. */
  readonly time: number;
  /** The pending change, or null: target child id and the heard time (seconds) it lands. */
  readonly transition: { to: string; time: number } | null;
  /**
   * Next grid point of that spec. For a pending change the points after `transition.time` are the new segment's
   * (`GridPoint.segment` says which). Null when not playing.
   */
  nextGrid(spec: GridSpec): GridPoint | null;
  /** Map an input timestamp (`performance.now()` ms) to the music (M4c); `segment` is null when not playing at that instant. */
  positionAt(performanceTime: number): MusicPositionAt;
  /**
   * Jump to a musical position `"bar:beat:tick"` (§2.2) within the segment playing when the seek lands (M4b; owner
   * decision 4; behaviour [ARCH §3.9], ruling R25).
   */
  seek(to: string): MusicSeekResult;
}

/** `Calibration.fromTaps`'s result (§1.5). Seconds unless stated. */
export interface CalibrationResult {
  /** The median of the kept offsets. */
  offset: number;
  /** Their median absolute deviation. */
  spread: number;
  /** `clamp01(1 - spread / 0.040) x min(1, used / 16)`. */
  confidence: number;
  /** Offsets kept after the warm-up. */
  used: number;
  /** Offsets dropped (the warm-up, non-finite values). */
  discarded: number;
  /** `spread <= 0.040` and `used >= 8`. */
  steady: boolean;
}

/** The `Calibration` namespace (§1.5): `fromTaps` over raw `MusicPositionAt.offset` values in seconds. */
export interface CalibrationApi {
  fromTaps(offsets: readonly number[], options?: { warmup?: number }): CalibrationResult;
}

/** `Audio.latency` (§1.3): seconds, read-only. `reliable` is 0 < output < 0.5 and not exactly 0 (S13). */
export interface AudioLatency {
  base: number;
  output: number;
  limiter: number;
  total: number;
  reliable: boolean;
}
