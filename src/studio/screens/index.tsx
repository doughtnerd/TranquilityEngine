// Every Studio screen's panels (ADR 0341 "The shell"): each screen's panel list comes from its own folder,
// `src/studio/screens/<screen>/`.
import type { StudioPanel } from "../shell/studioPanels";
import type { ScreenId } from "../shell/screens";
import { DIALOGUE_PANELS } from "./dialogue";
import { MIXER_PANELS } from "./mixer";
import { PACKAGES_PANELS } from "./packages";
import { PLAYLISTS_PANELS } from "./playlists";
import { profilerPanels } from "./profiler";
import { SAMPLES_PANELS } from "./samples";
import { SPATIAL_PANELS } from "./spatial";
import { ReplayTransport, TAKE_PANELS } from "./take";
import { takeScreen } from "./take/takeScreen";

export const SCREEN_PANELS: Readonly<Record<ScreenId, readonly StudioPanel[]>> = {
  samples: SAMPLES_PANELS,
  playlists: PLAYLISTS_PANELS,
  dialogue: DIALOGUE_PANELS,
  mixer: MIXER_PANELS,
  spatial: SPATIAL_PANELS,
  take: TAKE_PANELS,
  // One recording for both screens (ADR 0408): the Profiler gets what it needs of the Take screen here, so neither
  // screen imports the other (ADR 0433).
  profiler: profilerPanels({ openPath: (path) => void takeScreen().openPath(path), Transport: ReplayTransport }),
  packages: PACKAGES_PANELS,
};
