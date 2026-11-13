// The mix panels of the Audio plugin's editor half (ADR 0171 amended by 0172; api-and-models §7). `editor/index.ts` calls
// `registerMixPanels` once, beside `registerMusicPanels`; every mix panel registers here and nowhere else (no menu entry,
// toolbar button or global shortcut). The Profiler (Pf4) and the Mixer panel (Mp2b) are registered here.
//
// W8 slot fills for the Profiler panel (contract H5; see the top of `ProfilerPanel.tsx`) go in the marked block below,
// one import and one line each, so no task edits `ProfilerPanel.tsx`.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { OpLogEntry } from "./opLog";
import type { CaptureLoudnessTarget } from "../../runtime/capture/format";

export const PROFILER_PANEL = "audioprofiler";
export const MIXER_PANEL = "audiomixer";

export function registerMixPanels(context: EditorPluginContext): void {
  context.registerPanel({
    id: PROFILER_PANEL,
    title: "Audio Profiler",
    view: loadProfiler,
  });
  context.registerPanel({
    id: MIXER_PANEL,
    title: "Audio Mixer",
    view: loadMixer,
  });
}

let mixerReady: Promise<typeof import("./MixerPanel")["MixerPanel"]> | null = null;

/** Loads the Mixer panel once, lazily (nothing here loads before the panel opens). */
function loadMixer(): Promise<typeof import("./MixerPanel")["MixerPanel"]> {
  mixerReady ??= (async () => {
    const [m, { audioBackend }, { opLogEntries }] = await Promise.all([import("./MixerPanel"), import("../../runtime/backend"), import("../index")]);
    wireMixerHost(m.mixerHost, { flushNow: () => audioBackend().flushNow?.(), entries: opLogEntries });
    // `mixerHost.section` waits for the SDK surface of ADR 0173 (the shell's Project Settings section): until then the panel reads the draft.
    return m.MixerPanel;
  })();
  return mixerReady;
}

/** What the editor half hands the Mixer panel: the backend's `flushNow` and the op log's entries. */
export interface MixerHostSources {
  flushNow(): void;
  entries(): readonly OpLogEntry[];
}

/** Fill the panel's host with `sources` (G8a: previews post at once; the restart banner reads every recorded op). */
export function wireMixerHost(host: { flushNow: (() => void) | null; entries: (() => readonly OpLogEntry[]) | null }, sources: MixerHostSources): void {
  host.flushNow = () => sources.flushNow();
  host.entries = () => sources.entries();
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
    (await import("./openCapture")).installOpenCapture(m.profilerSlots);
    m.profilerSlots.tables = (await import("./profilerTables")).ProfilerTables;
    m.profilerSlots.bar = (await import("./ProfilerBar")).ProfilerBar;
    m.profilerSlots.banners = (await import("./ProfilerBanners")).ProfilerBanners;
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
