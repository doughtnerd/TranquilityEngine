/**
 * Where a clip's frames sit in time (ADR 0451, "As built: the clamped last frame"), the TypeScript side of the rule
 * `anim_format::frames` holds for the animation core: a clip of `duration` seconds at `rate` Hz has
 * `ceil(duration · rate − 1e-6) + 1` frames, frame `i` at `min(i / rate, duration)`. When `duration · rate` isn't
 * whole, the last frame sits at `duration`, less than a full frame after the one before it.
 */

/** @internal The frame count of a clip: `ceil(duration · rate − 1e-6) + 1`, at least 1. */
export const frameCount = (duration: number, rate: number): number => Math.max(1, Math.ceil(duration * rate - 1e-6) + 1);

/** @internal The time of frame `i`: `min(i / rate, duration)`. */
export const frameTime = (i: number, rate: number, duration: number): number => Math.min(i / rate, duration);

/**
 * @internal The frame time nearest `t`: the grid `k / rate`, or `duration` (the last frame's time) when it is nearer
 * or the grid point lies past it. Without a finite duration ≥ 0, the grid alone.
 */
export function snapToFrame(t: number, rate: number, duration?: number): number {
  const grid = Math.round(t * rate) / rate;
  if (duration === undefined || !(Number.isFinite(duration) && duration >= 0)) return grid;
  if (grid >= duration || Math.abs(t - duration) < Math.abs(t - grid)) return duration;
  return grid;
}
