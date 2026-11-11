// Ed4 (api-and-models §7, §2.7): the segment panel's tempo helpers. "Tempo from length and bar count" and tap tempo are
// editor functions; both only suggest a number, which the panel writes into the first tempo marker through the command
// stack. Pure: no clock, no DOM. L-Ed4a fills every stub below and un-skips `tempoTools.test.ts`.

/** One tap session's result. `bpm` is in beats of the segment's beat unit per minute, clamped to MIN_BPM..MAX_BPM. */
export interface TapTempoResult {
  /** 60 / median interval of the taps in the current run, clamped to the format's range. Not rounded. */
  readonly bpm: number;
  /** Taps in the current run that fed the median (after the reset and window rules). */
  readonly used: number;
  /** Median absolute deviation of the used intervals, seconds (0 for a single interval). */
  readonly spread: number;
}

export interface TapTempoOptions {
  /** A tap this many seconds after the previous one starts a new run (the earlier taps are dropped). Default 2. */
  readonly resetAfter?: number;
  /** Only the last `window` taps of the run are used. Default 8, minimum 2. */
  readonly window?: number;
}

/** Defaults of `TapTempoOptions`, exported so the panel and tests name them. */
export const TAP_RESET_SECONDS = 2;
export const TAP_WINDOW = 8;

/**
 * L-Ed4a. Tap tempo from tap timestamps in seconds (any origin, ascending; the panel passes `performance.now() / 1000`).
 *
 * Rule: take the run of taps after the last gap longer than `resetAfter` (a gap exactly equal to it does not reset);
 * keep the last `window` taps of the run; the intervals are the differences of neighbours; `bpm = 60 / median(interval)`
 * (the median of an even count is the mean of the two middle ones), clamped to `[MIN_BPM, MAX_BPM]` from musicFormat;
 * `used` is the number of taps kept; `spread` is the median absolute deviation of the intervals about their median.
 * Returns null when fewer than 2 taps are in the run, when a timestamp is not finite, or when the taps are not
 * strictly ascending (a zero or negative interval anywhere in the kept run).
 * Stub: returns null.
 */
export function tapTempo(taps: readonly number[], options?: TapTempoOptions): TapTempoResult | null {
  void taps; void options;
  return null; // L-Ed4a
}

/** The result of `tempoFromLength`. */
export interface LengthTempo {
  /** Beats of `beatUnit` per minute: `bars * beatsPerBar * 60 / usableSeconds`. Not rounded, not clamped. */
  readonly bpm: number;
  /** `bpm` lies in MIN_BPM..MAX_BPM, the range the format accepts. */
  readonly valid: boolean;
}

/**
 * L-Ed4a. Tempo from a clip's length and how many bars it holds at the given metre. `usableSeconds = seconds - gridOffset`
 * (`gridOffset` defaults to 0: the pickup before bar 1 is not part of the bars); the beat count is
 * `bars * beatsPerBar`, whatever the `beatUnit` (the unit only names the beat, so it does not change the number).
 * Returns null when `seconds`, `bars` or `beatsPerBar` is not finite and positive, when `bars` is not an integer, or
 * when `usableSeconds <= 0`.
 * Stub: returns null.
 */
export function tempoFromLength(seconds: number, bars: number, beatsPerBar: number, gridOffset?: number): LengthTempo | null {
  void seconds; void bars; void beatsPerBar; void gridOffset;
  return null; // L-Ed4a
}

/** One candidate of `barCountCandidates`. */
export interface BarCountCandidate {
  readonly bars: number;
  readonly bpm: number;
}

/**
 * L-Ed4a. The whole bar counts that give a tempo within `[minBpm, maxBpm]` (defaults 60 and 200) for a clip of `seconds`
 * at `beatsPerBar` (after subtracting `gridOffset`, as `tempoFromLength`), ascending by `bars`, at most `limit`
 * (default 8) entries, each with its `bpm` (same formula, unrounded). Empty when the inputs are invalid (as in
 * `tempoFromLength`) or no count fits. The panel offers them as a pick list beside the bars field.
 * Stub: returns [].
 */
export function barCountCandidates(
  seconds: number, beatsPerBar: number, options?: { readonly minBpm?: number; readonly maxBpm?: number; readonly gridOffset?: number; readonly limit?: number },
): BarCountCandidate[] {
  void seconds; void beatsPerBar; void options;
  return []; // L-Ed4a
}
