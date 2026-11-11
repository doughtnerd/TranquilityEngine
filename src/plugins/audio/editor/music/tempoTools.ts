// Ed4 (api-and-models §7, §2.7): the segment panel's tempo helpers. "Tempo from length and bar count" and tap tempo are
// editor functions; both only suggest a number, which the panel writes into the first tempo marker through the command
// stack. Pure: no clock, no DOM. L-Ed4a fills every stub below and un-skips `tempoTools.test.ts`.

import { MAX_BPM, MIN_BPM } from "../../../../engine/audio/musicFormat";

/** Median of a non-empty list (the mean of the two middle values for an even count). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

/** A finite number above zero. */
function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

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
 */
export function tapTempo(taps: readonly number[], options?: TapTempoOptions): TapTempoResult | null {
  if (!taps.every((t) => Number.isFinite(t))) return null;
  const resetAfter = options?.resetAfter ?? TAP_RESET_SECONDS;
  const requested = options?.window ?? TAP_WINDOW;
  const window = Number.isFinite(requested) ? Math.max(2, Math.floor(requested)) : TAP_WINDOW;

  // The run starts after the last gap longer than resetAfter.
  let start = 0;
  for (let i = 1; i < taps.length; i++) {
    if ((taps[i] ?? 0) - (taps[i - 1] ?? 0) > resetAfter) start = i;
  }
  const run = taps.slice(start);
  if (run.length < 2) return null;

  const kept = run.slice(-window);
  const intervals: number[] = [];
  for (let i = 1; i < kept.length; i++) {
    const d = (kept[i] ?? 0) - (kept[i - 1] ?? 0);
    if (!(d > 0)) return null;
    intervals.push(d);
  }

  const mid = median(intervals);
  const bpm = Math.min(MAX_BPM, Math.max(MIN_BPM, 60 / mid));
  const spread = median(intervals.map((d) => Math.abs(d - mid)));
  return { bpm, used: kept.length, spread };
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
 */
export function tempoFromLength(seconds: number, bars: number, beatsPerBar: number, gridOffset?: number): LengthTempo | null {
  const offset = gridOffset ?? 0;
  if (!isPositiveFinite(seconds) || !isPositiveFinite(bars) || !isPositiveFinite(beatsPerBar)) return null;
  if (!Number.isInteger(bars) || !Number.isFinite(offset)) return null;
  const usable = seconds - offset;
  if (!(usable > 0)) return null;
  const bpm = (bars * beatsPerBar * 60) / usable;
  return { bpm, valid: bpm >= MIN_BPM && bpm <= MAX_BPM };
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
 */
export function barCountCandidates(
  seconds: number, beatsPerBar: number, options?: { readonly minBpm?: number; readonly maxBpm?: number; readonly gridOffset?: number; readonly limit?: number },
): BarCountCandidate[] {
  const minBpm = options?.minBpm ?? 60;
  const maxBpm = options?.maxBpm ?? 200;
  const offset = options?.gridOffset ?? 0;
  const requestedLimit = options?.limit ?? 8;
  const limit = Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 8;
  if (!isPositiveFinite(seconds) || !isPositiveFinite(beatsPerBar) || !Number.isFinite(offset)) return [];
  const usable = seconds - offset;
  if (!(usable > 0) || Number.isNaN(minBpm) || Number.isNaN(maxBpm) || limit < 1) return [];

  // bpm rises with the bar count, so scan up from the first count near minBpm and stop past maxBpm.
  const out: BarCountCandidate[] = [];
  const perBar = (beatsPerBar * 60) / usable;
  for (let bars = Math.max(1, Math.floor(minBpm / perBar)); out.length < limit; bars++) {
    const bpm = (bars * beatsPerBar * 60) / usable;
    if (bpm > maxBpm) break;
    if (bpm >= minBpm) out.push({ bars, bpm });
  }
  return out;
}
