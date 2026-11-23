// Each screen's dock model, made the first time the screen shows (its saved layout read then), with the prototype's
// default arrangement (UI pass G70, shell-gaps K1): side panels stacked rather than tabbed, so the panel that goes
// with the one in hand shows beside it (a sample's Outline under Samples, the Library under Playlists, Game parameters
// under the Mixer's Inspector, Voice under the Profiler's At cursor). Sizes and splits follow the prototype at 1440px.
// A saved layout keeps working as it was; Reset layout gives these.
import { SCREEN_PANELS } from "../screens";
import type { ScreenId } from "./screens";
import { screenDock, type DockArrangement, type ScreenDockModel } from "./studioPanels";

export const SCREEN_ARRANGEMENTS: Readonly<Partial<Record<ScreenId, DockArrangement>>> = {
  samples: {
    left: { size: 250, groups: [["samples-library"], ["samples-outline"]], fractions: [0.36, 0.64] },
    right: { size: 310, groups: [["samples-inspector"]] },
    bottom: { size: 300, groups: [["samples-edits"], ["samples-seam"]], fractions: [0.5, 0.5] },
  },
  playlists: {
    left: { size: 260, groups: [["playlists-library"], ["playlists-samples"]], fractions: [0.58, 0.42] },
    right: { size: 320, groups: [["playlists-inspector"], ["playlists-voices", "playlists-parameters"]], fractions: [0.62, 0.38] },
  },
  mixer: {
    left: { size: 240, groups: [["mixer-snapshots"], ["mixer-gain"]], fractions: [0.55, 0.45] },
    right: { size: 340, groups: [["mixer-inspector"], ["mixer-parameters", "mixer-global-parameters"]], fractions: [0.7, 0.3] },
    bottom: { size: 200, groups: [["mixer-loudness"]] },
  },
  spatial: {
    left: { size: 230, groups: [["spatial-scenes"], ["spatial-outline"]], fractions: [0.32, 0.68] },
    right: { size: 320, groups: [["spatial-inspector"], ["spatial-settings"]], fractions: [0.55, 0.45] },
    bottom: { size: 200, groups: [["spatial-voices"]] },
  },
  take: {
    left: { size: 250, groups: [["take-list"], ["take-playlists"]], fractions: [0.4, 0.6] },
    right: { size: 300, groups: [["take-inspector"]] },
    bottom: { size: 220, groups: [["take-mixer"]] },
  },
  profiler: {
    left: { size: 230, groups: [["profiler-captures"]] },
    right: { size: 320, groups: [["profiler-cursor"], ["profiler-voice"]], fractions: [0.4, 0.6] },
    bottom: { size: 170, groups: [["profiler-messages"], ["profiler-why", "profiler-plugins"]], fractions: [0.55, 0.45] },
  },
};

const docks = new Map<ScreenId, ScreenDockModel>();

export function dockOf(screen: ScreenId): ScreenDockModel {
  let dock = docks.get(screen);
  if (!dock) docks.set(screen, (dock = screenDock(screen, SCREEN_PANELS[screen], SCREEN_ARRANGEMENTS[screen])));
  return dock;
}
