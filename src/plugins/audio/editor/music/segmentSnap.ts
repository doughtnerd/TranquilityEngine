// Ed3 (api-and-models §7): snapping for the segment view's drags. L-Ed3a fills `snapTicks`; until then it returns the
// ticks unchanged, so a drag preview works unsnapped. Pure.
import type { TempoMap } from "../../../../engine/audio/musicGrid";

/**
 * What a dragged cue, region edge or tempo marker snaps to (the view's Snap selector). `off` is also the Alt-held
 * behaviour of the view. `beat` is the `GridSpec` `"beat"` (960 ticks), `bar` the `GridSpec` `"bar"`; `half-beat` and
 * `quarter-beat` are the beat divided by 2 and 4 (480 and 240 ticks), the finer steps the selector adds.
 */
export type SnapMode = "off" | "bar" | "beat" | "half-beat" | "quarter-beat";

export const SNAP_MODES: readonly SnapMode[] = ["off", "bar", "beat", "half-beat", "quarter-beat"];

/** Ticks between the lines of the beat-based modes (`MUSIC_TICKS_PER_BEAT` / 1, 2, 4). `off` and `bar` have no fixed step. */
export const SNAP_STEP_TICKS: Readonly<Record<"beat" | "half-beat" | "quarter-beat", number>> = {
  beat: 960, "half-beat": 480, "quarter-beat": 240,
};

/**
 * L-Ed3a (Ed3's leaf). The integer tick nearest to `ticks` on the `mode` grid of the compiled `map`. Rules:
 * - `off`: `Math.round(ticks)`.
 * - `beat`, `half-beat`, `quarter-beat`: the nearest multiple of 960, 480, 240 ticks counted from `1:1:0` (every tempo
 *   marker sits on a beat, so these multiples are the lines in every span; `gridOffset` does not matter).
 * - `bar`: the nearest bar line, honouring metre changes. In span `i` the bar lines are `barOriginTick[i] + k *
 *   ticksPerBar[i]`; such a line counts only while it lies before the next marker, or at it when that marker is on
 *   beat 1 (`startBeat[next] === 1`, it is then the next span's own first line). A tempo-only marker mid-bar does not
 *   move the bar phase. The candidates are the last line at or before `ticks` and the first line after it (across span
 *   boundaries; `nextBarTicks` in `musicGrid.ts` finds the latter).
 * - A tie (exactly half-way) goes to the later line; the result is never negative (`ticks` < 0, the pickup, gives 0);
 *   `NaN` gives 0. The result is an integer and snapping it again returns it. Pure, `map` is read-only.
 * Stub: returns `Math.max(0, Math.round(ticks))` whatever the mode.
 */
export function snapTicks(map: TempoMap, ticks: number, mode: SnapMode): number {
  void map; void mode;
  return Math.max(0, Math.round(ticks));
}
