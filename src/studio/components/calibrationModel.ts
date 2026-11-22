// Latency calibration by tapping on the beat (ADR 0327, 0335; the prototype's output-device menu): a beat every
// 500 ms, heard (clicks) or seen (flashing boxes). Each tap's signed error from the nearest beat is folded into
// ±250 ms, the last 16 taps are kept, and their average is the offset to use once there are at least 4. Offsets are
// kept within ±300 ms.

/** The beat period, ms. */
export const BEAT_MS = 500;
/** Taps averaged. */
export const KEEP_TAPS = 16;
/** Taps needed before the average can be used. */
export const MIN_TAPS = 4;
/** An offset's limit either way, ms. */
export const OFFSET_LIMIT_MS = 300;

/** A tap at `tapMs` against beats at `startMs + k·period`: its signed error from the nearest beat, in [-period/2, period/2). */
export function foldError(tapMs: number, startMs: number, period = BEAT_MS): number {
  const half = period / 2;
  const r = (((tapMs - startMs + half) % period) + period) % period;
  return r - half;
}

/** The beat a moment falls in (0, 1, 2… from `startMs`), for the flashing boxes and the clicks. */
export const beatIndex = (nowMs: number, startMs: number, period = BEAT_MS): number => Math.floor((nowMs - startMs) / period);

export interface TapSummary {
  /** Taps kept (at most `KEEP_TAPS`). */
  readonly count: number;
  /** Their average error, ms (rounded); null with no taps. */
  readonly average: number | null;
  /** Their spread (mean absolute deviation), ms; null with no taps. */
  readonly spread: number | null;
  /** Enough taps to use the average. */
  readonly usable: boolean;
  /** The offset "Use" would set: the average, clamped to ±300 ms; null until usable. */
  readonly offset: number | null;
}

/** `taps` with `error` added, keeping the last `KEEP_TAPS`. */
export const addTap = (taps: readonly number[], error: number): number[] => [...taps, error].slice(-KEEP_TAPS);

export function summarize(taps: readonly number[]): TapSummary {
  const kept = taps.slice(-KEEP_TAPS);
  if (kept.length === 0) return { count: 0, average: null, spread: null, usable: false, offset: null };
  const mean = kept.reduce((s, x) => s + x, 0) / kept.length;
  const spread = kept.reduce((s, x) => s + Math.abs(x - mean), 0) / kept.length;
  const usable = kept.length >= MIN_TAPS;
  return { count: kept.length, average: Math.round(mean), spread: Math.round(spread), usable, offset: usable ? clampOffset(mean) : null };
}

/** An offset (ms) rounded and kept within ±300 ms; anything not a number is 0. */
export function clampOffset(ms: unknown): number {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, Math.round(n)));
}

/** An offset as the menu writes it: "+23 ms", "−12 ms", "0 ms". */
export const formatOffset = (ms: number): string => (ms > 0 ? `+${ms} ms` : ms < 0 ? `−${-ms} ms` : "0 ms");
