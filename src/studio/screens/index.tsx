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
import { TAKE_PANELS } from "./take";

const purpose = (id: ScreenId) => SCREENS.find((s) => s.id === id)!.purpose;

export const SCREEN_PANELS: Readonly<Record<ScreenId, readonly StudioPanel[]>> = {
  samples: SAMPLES_PANELS,
  playlists: PLAYLISTS_PANELS,
  mixer: MIXER_PANELS,
  spatial: [
    placeholderPanel({ id: "spatial-scenes", title: "Test scenes", dock: "left", empty: "No test scenes yet", body: "Scenes of sources, a listener and zones to hear spatial settings in." }),
    placeholderPanel({ id: "spatial-scene", title: "Scene", dock: "fill", fixed: true, icon: "◎", empty: "Spatial", body: <p>{purpose("spatial")}</p> }),
    placeholderPanel({ id: "spatial-attenuation", title: "Attenuation", dock: "right", empty: "Nothing selected", body: "The selected attenuation curve or preset." }),
    historyPanel("spatial"),
  ],
  take: TAKE_PANELS,
  profiler: PROFILER_PANELS,
};
