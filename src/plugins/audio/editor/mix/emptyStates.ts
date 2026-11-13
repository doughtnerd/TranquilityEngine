// The profiler's empty-state strings (design 0171 api-and-models §7, the `emptyStates.ts` row), exactly as the design
// gives them, and the chooser that picks one from the source's state. Pure: no DOM.

/** The six empty states. */
export type EmptyStateKind = "notPlaying" | "notRecording" | "cpuNotMeasured" | "notMetered" | "truncated" | "babylonNoCpu";

/** The design's text for each empty state. */
export const EMPTY_STATES: Readonly<Record<EmptyStateKind, string>> = {
  notPlaying: "Not playing",
  notRecording: "Recording starts when the panel opens in Play",
  cpuNotMeasured: "CPU not yet measured",
  notMetered: "Not metered",
  truncated: "Truncated: the ring wrapped",
  babylonNoCpu: "Babylon fallback: no CPU line",
};

/** The profiler views that can show an empty state. */
export type ProfilerView = "cpu" | "voices" | "underruns" | "ladder" | "buses" | "busFactors" | "loudness" | "events" | "music";

/** What the chooser needs to know about the source. */
export interface EmptyStateSource {
  /** The editor is in Play. */
  playing: boolean;
  /** A capture (live ring, saved or dropped file) is open. */
  hasCapture: boolean;
  /** The capture is main-side only (the Babylon fallback: no CPU, underrun or loudness tracks). */
  mainSideOnly?: boolean;
  /** The capture is truncated (the ring wrapped over its start). */
  truncated?: boolean;
  /** The cursor is before the first keyframe, so there is nothing to show yet. */
  beforeFirstKeyframe?: boolean;
  /** `cpu.loadPermille` at the cursor: null until the first window fills. */
  cpuLoadPermille?: number | null;
  /** The view's bus (loudness view) is metered. */
  metered?: boolean;
}

/**
 * The empty state for `view`, or null when the view has data. Order: no capture (Not playing outside Play, the recording
 * message in Play), then the Babylon fallback's missing CPU, underrun and loudness tracks, CPU not yet measured,
 * Not metered, and Truncated when the cursor precedes the truncated file's first keyframe.
 */
export function chooseEmptyState(view: ProfilerView, source: EmptyStateSource): string | null {
  const kind = chooseEmptyStateKind(view, source);
  return kind === null ? null : EMPTY_STATES[kind];
}

/** As `chooseEmptyState`, returning the kind. */
export function chooseEmptyStateKind(view: ProfilerView, source: EmptyStateSource): EmptyStateKind | null {
  if (!source.hasCapture) return source.playing ? "notRecording" : "notPlaying";
  if (source.mainSideOnly) {
    if (view === "cpu") return "babylonNoCpu";
    if (view === "loudness") return "notMetered";
  }
  if (view === "cpu" && (source.cpuLoadPermille === null || source.cpuLoadPermille === undefined)) return "cpuNotMeasured";
  if (view === "loudness" && source.metered === false) return "notMetered";
  if (source.truncated && source.beforeFirstKeyframe) return "truncated";
  return null;
}
