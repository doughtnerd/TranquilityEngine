// Every Studio screen's panels (ADR 0341 "The shell"): each screen's panel list comes from its own folder,
// `src/studio/screens/<screen>/`.
import type { StudioPanel } from "../shell/studioPanels";
import type { ScreenId } from "../shell/screens";
import { DIALOGUE_PANELS } from "./dialogue";
import { MIXER_PANELS } from "./mixer";
import { PACKAGES_PANELS } from "./packages";
import { PLAYLISTS_PANELS } from "./playlists";
import { PROFILER_PANELS } from "./profiler";
import { SAMPLES_PANELS } from "./samples";
import { SPATIAL_PANELS } from "./spatial";
import { TAKE_PANELS } from "./take";

export const SCREEN_PANELS: Readonly<Record<ScreenId, readonly StudioPanel[]>> = {
  samples: SAMPLES_PANELS,
  playlists: PLAYLISTS_PANELS,
  dialogue: DIALOGUE_PANELS,
  mixer: MIXER_PANELS,
  spatial: SPATIAL_PANELS,
  take: TAKE_PANELS,
  profiler: PROFILER_PANELS,
  packages: PACKAGES_PANELS,
};
