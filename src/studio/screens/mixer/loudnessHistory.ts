// The Loudness panel's graph (spec §4.3.6 "short-term loudness over the last 60 s with the target line"; the
// prototype's sparkline): the short-term readings of the last 60 s, sampled at most twice a second, drawn as a polyline
// in a 600×50 box on a fixed LUFS scale with the target as a level line. Silence (no reading) breaks nothing: it is
// simply not sampled. Pure.

/** The graph's window, seconds. */
export const SHORT_TERM_WINDOW_S = 60;
/** The least time between two samples, seconds. */
const SAMPLE_S = 0.5;
/** The scale: the box's bottom and top, LUFS. */
export const SPARK_FLOOR_LUFS = -42;
export const SPARK_CEIL_LUFS = -6;
const W = 600;
const H = 50;

export interface LoudnessPoint {
  /** Seconds (any clock that only goes forward). */
  readonly t: number;
  readonly lufs: number;
}

/** `history` with the reading at `t` added (when it is a number and half a second has passed), older than 60 s dropped. */
export function pushReading(history: readonly LoudnessPoint[], t: number, lufs: number | null): LoudnessPoint[] {
  const kept = history.filter((p) => p.t > t - SHORT_TERM_WINDOW_S && p.t <= t);
  const last = kept[kept.length - 1];
  if (lufs === null || !Number.isFinite(lufs) || (last && t - last.t < SAMPLE_S)) return kept;
  return [...kept, { t, lufs }];
}

const yOf = (lufs: number) => {
  const f = (Math.min(SPARK_CEIL_LUFS, Math.max(SPARK_FLOOR_LUFS, lufs)) - SPARK_FLOOR_LUFS) / (SPARK_CEIL_LUFS - SPARK_FLOOR_LUFS);
  return Math.round((1 - f) * H * 10) / 10;
};

/** The polyline's points (the newest at the right edge) and the target line's y (null without a target). */
export function sparkline(history: readonly LoudnessPoint[], now: number, target: number | null): { points: [number, number][]; target: number | null } {
  const points = history
    .filter((p) => p.t > now - SHORT_TERM_WINDOW_S && p.t <= now)
    .map((p): [number, number] => [Math.round(((p.t - (now - SHORT_TERM_WINDOW_S)) / SHORT_TERM_WINDOW_S) * W * 10) / 10, yOf(p.lufs)]);
  return { points, target: target === null ? null : yOf(target) };
}
