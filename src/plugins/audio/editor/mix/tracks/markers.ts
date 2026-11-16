// ADR 0171 amended by 0172 (M5a, task Pf3d; api-and-models §7, architecture §3.7): the profiler's marker track, pure.
// A marker (`ProfileSink.marker`, a MARKER record: `ProfileSource.markers`) is a tick on `markers.markers`; its hover is
// `markerTooltip`'s string. The times are `cursorModel.ts`'s `cursorTargets().marker` (the source's marker seconds less
// `startSeconds`, sorted), so a tick sits where `cursor.find("marker", ...)`'s previous and next land.
import type { CaptureMarkerAt } from "../../../runtime/capture/reader";
import type { ProfileSource } from "../profilerSource";
import { MAX_TOOLTIP_LINES, formatSeconds, hoverModule, indicesNear, listText, type HoverTrackModule } from "./events";
import type { TrackContext, TrackFactory } from "./types";

/** A marker on the viewport axis. */
interface MarkerTick {
  readonly time: number;
  readonly text: string;
}

/** The sorted markers on the viewport axis (`cursorTargets`' rebasing and order). */
function markerTicks(markers: readonly CaptureMarkerAt[], startSeconds: number): MarkerTick[] {
  return markers.map((m) => ({ time: m.seconds - startSeconds, text: m.text })).sort((a, b) => a.time - b.time);
}

/** `1.250 s  Boss spawned`. */
function markerText(m: MarkerTick): string {
  return `${formatSeconds(m.time)}  ${m.text}`;
}

/** The markers within `tolerance` of `t`, one line each. */
function markerTooltip(markers: readonly MarkerTick[], t: number, tolerance: number): string | null {
  const [from, to] = indicesNear(markers.map((m) => m.time), t, tolerance);
  return listText(markers.slice(from, Math.min(to, from + MAX_TOOLTIP_LINES)).map(markerText), to - from);
}

function markerTrack(source: ProfileSource): HoverTrackModule {
  let markers: MarkerTick[] = [];
  const read = () => {
    markers = markerTicks(source.markers, source.startSeconds);
    return {
      data: markers.length ? { ticks: Float64Array.from(markers, (m) => m.time), tickColor: "warning" as const } : undefined,
      tooltip: (t: number, tol: number) => markerTooltip(markers, t, tol),
    };
  };
  return hoverModule({ id: "markers.markers", label: "Markers", kind: "ticks", height: 22, visible: true }, null, read);
}

/** The marker track of an opened capture. */
export const markerTracks: TrackFactory = (ctx: TrackContext) => [markerTrack(ctx.source)];

