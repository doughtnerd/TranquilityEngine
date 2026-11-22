// Every Studio screen's panels (ADR 0327 "The shell"). Until each screen's milestone builds it (Samples M3,
// Playlists M4–M5, Mixer M6, Spatial M7, Take M8, Profiler M9), its panels are placeholders saying what they are for.
// A milestone replaces its screen's entry with its own panel list from `src/studio/screens/<screen>/`.
import type { StudioPanel } from "../shell/studioPanels";
import { SCREENS, type ScreenId } from "../shell/screens";
import { historyPanel, placeholderPanel } from "./placeholder";
import { MIXER_PANELS } from "./mixer";
import { PLAYLISTS_PANELS } from "./playlists";
import { PROFILER_PANELS } from "./profiler";
import { SAMPLES_PANELS } from "./samples";
import { SPATIAL_PANELS } from "./spatial";

const purpose = (id: ScreenId) => SCREENS.find((s) => s.id === id)!.purpose;

export const SCREEN_PANELS: Readonly<Record<ScreenId, readonly StudioPanel[]>> = {
  samples: SAMPLES_PANELS,
  playlists: PLAYLISTS_PANELS,
  mixer: MIXER_PANELS,
  spatial: SPATIAL_PANELS,
  take: [
    placeholderPanel({ id: "take-list", title: "Takes", dock: "left", empty: "No takes yet", body: "Record a take while playing the game in the editor or a game build; takes saved in the project show here." }),
    placeholderPanel({ id: "take-timeline", title: "Timeline", dock: "fill", fixed: true, icon: "◉", empty: "Take", body: <p>{purpose("take")} Open a take to replay it.</p> }),
    placeholderPanel({ id: "take-inspector", title: "Instance", dock: "right", empty: "Nothing selected", body: "The selected instance: what asked for it, what it played, and notes." }),
  ],
  profiler: PROFILER_PANELS,
};
