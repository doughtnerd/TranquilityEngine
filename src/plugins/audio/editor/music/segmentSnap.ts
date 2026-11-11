// Ed3 (api-and-models §7): snapping for the segment view's drags. Pure.
import { nextBarTicks, spanAtTicks, type TempoMap } from "../../../../engine/audio/musicGrid";

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
 * The largest bar line of span `j` that is at or before `bound` (`bound >= 0`), or -1 when span `j` has none. A line
 * belongs to span `j` while it lies in `[startTick[j], startTick[j+1])`, or at `startTick[j+1]` when that marker is on
 * beat 1 (then it is the next span's own first line, the same value).
 */
function lastBarLineInSpan(map: TempoMap, j: number, bound: number): number {
  const last = j + 1 < map.count;
  const beatOneNext = last && map.startBeat[j + 1] === 1;
  // Integer lines: a line strictly before the next marker is at most next - 1; at the marker only when it is beat 1.
  const limit = last ? (beatOneNext ? map.startTick[j + 1] : map.startTick[j + 1] - 1) : Infinity;
  const b = Math.min(bound, limit);
  const origin = map.barOriginTick[j];
  const perBar = map.ticksPerBar[j];
  let line = origin + Math.floor((b - origin) / perBar) * perBar;
  while (line > b) line -= perBar;
  while (line + perBar <= b) line += perBar;
  return line >= map.startTick[j] ? line : -1;
}

/** The last bar line at or before `ticks` (`ticks >= 0`), across span boundaries. Allocation free. */
function barLineAtOrBefore(map: TempoMap, ticks: number): number {
  for (let j = spanAtTicks(map, ticks); j >= 0; j--) {
    const line = lastBarLineInSpan(map, j, ticks);
    if (line >= 0) return line;
  }
  return 0; // unreachable: span 0's lines start at 0
}

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
 */
export function snapTicks(map: TempoMap, ticks: number, mode: SnapMode): number {
  if (Number.isNaN(ticks)) return 0;
  if (mode === "off") return Math.max(0, Math.round(ticks)) + 0;
  if (mode === "bar") {
    if (ticks <= 0) return 0; // the pickup has no bar line before 1:1:0, and 1:1:0 is the first
    const next = nextBarTicks(map, ticks);
    if (next === ticks) return next;
    const prev = barLineAtOrBefore(map, ticks);
    return ticks - prev < next - ticks ? prev : next; // a tie goes to the later line
  }
  const step = SNAP_STEP_TICKS[mode];
  // Math.round sends an exact half-way point up, i.e. to the later line; -0 and negatives clamp to the grid start.
  return Math.max(0, Math.round(ticks / step) * step) + 0;
}
