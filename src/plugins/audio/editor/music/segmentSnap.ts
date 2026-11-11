// Ed3 (api-and-models §7): snapping for the segment view's drags. L-Ed3a fills `snapTicks`; until then it returns the
// ticks unchanged, so a drag preview works unsnapped. Pure.
import type { TempoMap } from "../../../../engine/audio/musicGrid";

/** What a dragged cue, region edge or tempo marker snaps to. `off` is the Alt-held behaviour of the view. */
export type SnapMode = "off" | "bar" | "beat" | "half-beat" | "quarter-beat";

export const SNAP_MODES: readonly SnapMode[] = ["off", "bar", "beat", "half-beat", "quarter-beat"];

/**
 * L-Ed3a (Ed3's leaf). Integer ticks nearest to `ticks` on the `mode` grid of the compiled `map` (bars follow the metre in
 * force, so a bar line after a metre change is where the map puts it). `off` returns `Math.round(ticks)`. Never negative.
 * Stub: returns `Math.max(0, Math.round(ticks))` whatever the mode.
 */
export function snapTicks(map: TempoMap, ticks: number, mode: SnapMode): number {
  void map; void mode;
  return Math.max(0, Math.round(ticks));
}
