// ADR 0171 amended by 0172 (M5a, task Pf3d; api-and-models §7, architecture §3.7): the profiler's marker track, pure.
// A marker (`ProfileSink.marker`, a MARKER record: `ProfileSource.markers`) is a tick on `markers.markers`; its hover is
// `markerTooltip`'s string. A click on one asks the cursor to jump: the panel calls the module's `markerAt(t, tolerance)`
// with the clicked time and, on a hit, `jumpToMarker(cursor, hit)`, which lands the cursor (paused, whatever it was doing,
// live included) on the marker's time. The times are `cursorModel.ts`'s `cursorTargets().marker` (the source's marker seconds
// less `startSeconds`, sorted), so `cursor.find("marker", ...)`'s previous and next agree with what a click lands on.
import type { CaptureMarkerAt } from "../../../runtime/capture/reader";
import type { CursorModel } from "../cursorModel";
import type { ProfileSource } from "../profilerSource";
import { MAX_TOOLTIP_LINES, formatSeconds, hoverModule, indicesNear, listText, type HoverTrackModule } from "./events";
import type { TrackContext, TrackFactory } from "./types";

/** A marker on the viewport axis. */
export interface MarkerTick {
  readonly time: number;
  readonly text: string;
}

/** The sorted markers on the viewport axis (`cursorTargets`' rebasing and order). */
export function markerTicks(markers: readonly CaptureMarkerAt[], startSeconds: number): MarkerTick[] {
  return markers.map((m) => ({ time: m.seconds - startSeconds, text: m.text })).sort((a, b) => a.time - b.time);
}

/** `1.250 s  Boss spawned`. */
export function markerText(m: MarkerTick): string {
  return `${formatSeconds(m.time)}  ${m.text}`;
}

/** The markers within `tolerance` of `t`, one line each. */
export function markerTooltip(markers: readonly MarkerTick[], t: number, tolerance: number): string | null {
  const [from, to] = indicesNear(markers.map((m) => m.time), t, tolerance);
  return listText(markers.slice(from, Math.min(to, from + MAX_TOOLTIP_LINES)).map(markerText), to - from);
}

/** The marker nearest `t` within `tolerance` seconds (the earlier on a tie), or null. */
export function markerNear(markers: readonly MarkerTick[], t: number, tolerance: number): MarkerTick | null {
  const [from, to] = indicesNear(markers.map((m) => m.time), t, tolerance);
  let best: MarkerTick | null = null;
  for (let i = from; i < to; i++) {
    const m = markers[i]!;
    if (best === null || Math.abs(m.time - t) < Math.abs(best.time - t)) best = m;
  }
  return best;
}

/** Asks the cursor to jump to the marker: paused on its time. False (unchanged) when there is none. */
export function jumpToMarker(cursor: CursorModel, marker: MarkerTick | null): boolean {
  if (!marker) return false;
  cursor.seekTo(marker.time);
  return true;
}

/** The marker track, with the panel's click lookup. */
export type MarkerTrackModule = HoverTrackModule & {
  /** The marker under a click at `t` (default reach: the module's `tolerance`). */
  markerAt(t: number, tolerance?: number): MarkerTick | null;
};

export function markerTrack(source: ProfileSource): MarkerTrackModule {
  let markers: MarkerTick[] = [];
  const read = () => {
    markers = markerTicks(source.markers, source.startSeconds);
    return {
      data: markers.length ? { ticks: Float64Array.from(markers, (m) => m.time), tickColor: "warning" as const } : undefined,
      tooltip: (t: number, tol: number) => markerTooltip(markers, t, tol),
    };
  };
  const m = hoverModule({ id: "markers.markers", label: "Markers", kind: "ticks", height: 22, visible: true }, null, read) as MarkerTrackModule;
  m.markerAt = (t, tolerance = m.tolerance) => markerNear(markers, t, tolerance);
  return m;
}

/** The marker track of an opened capture. */
export const markerTracks: TrackFactory = (ctx: TrackContext) => [markerTrack(ctx.source)];

