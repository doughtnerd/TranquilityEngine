// Every Studio screen's panels (ADR 0327 "The shell"). Until each screen's milestone builds it (Samples M3,
// Playlists M4–M5, Mixer M6, Spatial M7, Take M8, Profiler M9), its panels are placeholders saying what they are for.
// A milestone replaces its screen's entry with its own panel list from `src/studio/screens/<screen>/`.
import type { StudioPanel } from "../shell/studioPanels";
import { SCREENS, type ScreenId } from "../shell/screens";
import { historyPanel, placeholderPanel } from "./placeholder";
import { SAMPLES_PANELS } from "./samples";

const purpose = (id: ScreenId) => SCREENS.find((s) => s.id === id)!.purpose;

export const SCREEN_PANELS: Readonly<Record<ScreenId, readonly StudioPanel[]>> = {
  samples: SAMPLES_PANELS,
  playlists: [
    placeholderPanel({ id: "playlists-library", title: "Playlists", dock: "left", empty: "No playlists yet", body: "The project's playlists by folder. Create one to start." }),
    placeholderPanel({ id: "playlists-editor", title: "Playlist", dock: "fill", fixed: true, icon: "≡", empty: "Playlists", body: <p>{purpose("playlists")} Pick a playlist to edit and audition it.</p> }),
    placeholderPanel({ id: "playlists-inspector", title: "Inspector", dock: "right", empty: "Nothing selected", body: "The selected entry's playback rules, voice curves, effects and output." }),
    placeholderPanel({ id: "playlists-voices", title: "Plays now", dock: "bottom", empty: "Nothing playing", body: "What an audition plays, voice by voice, and why." }),
    historyPanel("playlists"),
  ],
  mixer: [
    placeholderPanel({ id: "mixer-snapshots", title: "Snapshots", dock: "left", empty: "No snapshots yet", body: "Named mixes the game blends to (a pause menu, underwater)." }),
    placeholderPanel({ id: "mixer-board", title: "Mixer", dock: "fill", fixed: true, icon: "☰", empty: "Mixer", body: <p>{purpose("mixer")} Changes are heard through the Studio's runtime: audition a playlist or replay a take.</p> }),
    placeholderPanel({ id: "mixer-inspector", title: "Inspector", dock: "right", empty: "Nothing selected", body: "The selected bus's effects, sends and ducking." }),
    historyPanel("mixer"),
  ],
  spatial: [
    placeholderPanel({ id: "spatial-scenes", title: "Test scenes", dock: "left", empty: "No test scenes yet", body: "Scenes of sources, a listener and zones to hear spatial settings in." }),
    placeholderPanel({ id: "spatial-scene", title: "Scene", dock: "fill", fixed: true, icon: "◎", empty: "Spatial", body: <p>{purpose("spatial")}</p> }),
    placeholderPanel({ id: "spatial-attenuation", title: "Attenuation", dock: "right", empty: "Nothing selected", body: "The selected attenuation curve or preset." }),
    historyPanel("spatial"),
  ],
  take: [
    placeholderPanel({ id: "take-list", title: "Takes", dock: "left", empty: "No takes yet", body: "Record a take while playing the game in the editor or a game build; takes saved in the project show here." }),
    placeholderPanel({ id: "take-timeline", title: "Timeline", dock: "fill", fixed: true, icon: "◉", empty: "Take", body: <p>{purpose("take")} Open a take to replay it.</p> }),
    placeholderPanel({ id: "take-inspector", title: "Instance", dock: "right", empty: "Nothing selected", body: "The selected instance: what asked for it, what it played, and notes." }),
  ],
  profiler: [
    placeholderPanel({ id: "profiler-captures", title: "Captures", dock: "left", empty: "No captures yet", body: "Start a capture in the editor or a game build, or capture a take as it replays here; saved captures show here." }),
    placeholderPanel({ id: "profiler-tracks", title: "Tracks", dock: "fill", fixed: true, icon: "▤", empty: "Profiler", body: <p>{purpose("profiler")} Open a capture to inspect it.</p> }),
    placeholderPanel({ id: "profiler-details", title: "Details", dock: "right", empty: "Nothing selected", body: "The selected voice and why it played." }),
    placeholderPanel({ id: "profiler-log", title: "Log", dock: "bottom", empty: "No events", body: "The capture's events and warnings in time order." }),
  ],
};
