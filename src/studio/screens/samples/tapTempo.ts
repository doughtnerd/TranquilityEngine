// Tap tempo (the prototype's Tempo popover): taps' times in ms; the tempo is the mean of the last 8 intervals; a pause
// over 2 s starts a new run; steadiness from the intervals' spread (steady under 4 %, a bit uneven under 10 %,
// else uneven). "Use" needs 20–400 BPM. Pure.

export const TAP_INTERVALS = 8;
export const TAP_RESET_MS = 2000;

export type Steadiness = "steady" | "a bit uneven" | "uneven";

export interface TapResult {
  readonly bpm: number;
  readonly steadiness: Steadiness;
  /** Taps in the run. */
  readonly taps: number;
  readonly usable: boolean;
}

/** The run after a tap at `now` ms: a new run after a long pause, at most 9 taps (8 intervals) kept. */
export function addTap(taps: readonly number[], now: number): number[] {
  const last = taps[taps.length - 1];
  const run = last !== undefined && now - last <= TAP_RESET_MS && now > last ? [...taps, now] : [now];
  return run.slice(-(TAP_INTERVALS + 1));
}

/** The tempo the taps give, or null with fewer than two. */
export function tapResult(taps: readonly number[]): TapResult | null {
  if (taps.length < 2) return null;
  const iv = taps.slice(1).map((t, i) => t - taps[i]);
  const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
  const dev = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length) / mean;
  const bpm = Math.round((60000 / mean) * 10) / 10;
  return { bpm, steadiness: dev < 0.04 ? "steady" : dev < 0.1 ? "a bit uneven" : "uneven", taps: taps.length, usable: bpm >= 20 && bpm <= 400 };
}
