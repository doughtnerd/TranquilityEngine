// The mix panels of the Audio plugin's editor half (ADR 0171 amended by 0172; api-and-models §7). `editor/index.ts` calls
// `registerMixPanels` once, beside `registerMusicPanels`; every mix panel registers here and nowhere else (no menu entry,
// toolbar button or global shortcut). The Profiler is registered now (Pf4); the Mixer panel (Mp2b) registers here later.
//
// W8 slot fills for the Profiler panel (contract H5; see the top of `ProfilerPanel.tsx`) go in the marked block below,
// one import and one line each, so no task edits `ProfilerPanel.tsx`.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { CaptureLoudnessTarget } from "../../runtime/capture/format";

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
    const [m, cpu, counters, voices, buses, events, music, markers, loudness] = await Promise.all([
      import("./ProfilerPanel"),
      import("./tracks/cpu"),
      import("./tracks/counters"),
      import("./tracks/voices"),
      import("./tracks/buses"),
      import("./tracks/events"),
      import("./tracks/music"),
      import("./tracks/markers"),
      import("./tracks/loudness"),
    ]);
    // --- Profiler slot fills: one line each (W8: Pf5's tables, Pf8's bar and banners, X2's drop route; Rc4's host; Pf6's loudness track) ---
    m.profilerHost.liveHost = (await import("../../runtime/capture/capture")).captureLiveHost;
    const [{ Audio }, { mixer }] = await Promise.all([import("../../runtime/Audio"), import("../../../../engine/audio/mixer")]);
    m.profilerTrackFactories.push(cpu.cpuTracks, counters.counterTracks, voices.voicesTracks, buses.busTracks, events.eventTracks, music.musicTracks, markers.markerTracks);
    // Pf6's loudness track with the project's target in force: the session's `Audio.loudnessTarget` named in `audio.loudnessTargets`.
    m.profilerTrackFactories.push(loudness.loudnessTracks({ target: () => loudnessTargetNamed(mixer.audioSettings.loudnessTargets, Audio.loudnessTarget) }));
    return m.ProfilerPanel;
  })();
  return profilerReady;
}

/** The entry of `audio.loudnessTargets` the session checks against (`Audio.loudnessTarget`), or null when none is selected or the name isn't in the list. */
export function loudnessTargetNamed(targets: readonly CaptureLoudnessTarget[] | undefined, name: string | null): CaptureLoudnessTarget | null {
  if (name === null) return null;
  return targets?.find((t) => t.name === name) ?? null;
}
