// The mix panels of the Audio plugin's editor half (ADR 0171 amended by 0172; api-and-models §7). `editor/index.ts` calls
// `registerMixPanels` once, beside `registerMusicPanels`; every mix panel registers here and nowhere else (no menu entry,
// toolbar button or global shortcut). The Profiler is registered now (Pf4); the Mixer panel (Mp2b) registers here later.
//
// W8 slot fills for the Profiler panel (contract H5; see the top of `ProfilerPanel.tsx`) go in the marked block below,
// one import and one line each, so no task edits `ProfilerPanel.tsx`.
import type { EditorPluginContext } from "../../../../editor/sdk";

export const PROFILER_PANEL = "audioprofiler";

export function registerMixPanels(context: EditorPluginContext): void {
  context.registerPanel({
    id: PROFILER_PANEL,
    title: "Audio Profiler",
    view: loadProfiler,
  });
}

let profilerReady: Promise<typeof import("./ProfilerPanel")["ProfilerPanel"]> | null = null;

/** Loads the panel and its fills once, lazily (nothing here loads before the panel opens). */
function loadProfiler(): Promise<typeof import("./ProfilerPanel")["ProfilerPanel"]> {
  profilerReady ??= (async () => {
    const [m, cpu, counters, voices, buses, events, music, markers] = await Promise.all([
      import("./ProfilerPanel"),
      import("./tracks/cpu"),
      import("./tracks/counters"),
      import("./tracks/voices"),
      import("./tracks/buses"),
      import("./tracks/events"),
      import("./tracks/music"),
      import("./tracks/markers"),
    ]);
    // --- Profiler slot fills: one line each (W8: Pf5's tables, Pf8's bar and banners, X2's drop route; Rc4's host; Pf6's loudness track) ---
    m.profilerTrackFactories.push(cpu.cpuTracks, counters.counterTracks, voices.voicesTracks, buses.busTracks, events.eventTracks, music.musicTracks, markers.markerTracks);
    return m.ProfilerPanel;
  })();
  return profilerReady;
}
