// ADR 0171 amended by 0172 (M5a, wave 7; a coordinator contract for Pf3b, Pf3c, Pf3d and Pf4): what a profiler track
// module hands the panel. Each module in `tracks/` exports one or more `TrackModule`s built from the capture and the pure
// models (`cpuTrack.ts`, `voiceTableModel.ts`, `busFactorsModel.ts`, `cursorModel.ts`); the panel (Pf4) puts their
// `track`s in its `TrackList` and answers `TimelineCanvas`'s `data(trackId)` from them. Track modules draw nothing
// themselves: `drawTimeline.ts` draws `TrackData`.
import type { ProfileSource } from "../profilerSource";
import type { TrackData } from "../drawTimeline";
import type { Track } from "../timelineModel";

/** What a track module reads: the open capture and the panel's name lookups. */
export interface TrackContext {
  readonly source: ProfileSource;
  /** Clip, bus (by slot) and event names, as `voiceTableModel.ts`'s `NameLookup` gives them. */
  readonly names: { clip(id: number): string | undefined; bus(slot: number): string | undefined; event(id: number): string | undefined };
}

/** One track: its row in the list, its data, and the text a hover shows. */
export interface TrackModule {
  /** Its row (`id` unique across all modules; prefix it with the module's name, e.g. `cpu.load`). */
  readonly track: Track;
  /**
   * Its data over the whole capture (the canvas downsamples and caches it). Called when the cache is cold or after
   * `refresh`; returns `undefined` when the capture has nothing for it (the panel shows the empty state).
   */
  data(): TrackData | undefined;
  /** Re-reads the source after it grew (live) or changed; resolves when `data()` has the new values. */
  refresh(): Promise<void>;
  /** The hover text at capture time `t` (seconds on the viewport's axis), or `null` for none. A model's string, never built in a view. */
  tooltipAt?(t: number): string | null;
}

/** A module's factory: the panel calls it once per opened capture. */
export type TrackFactory = (ctx: TrackContext) => readonly TrackModule[];
