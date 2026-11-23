// Each screen's dock model, made the first time the screen shows (its saved layout read then).
import { SCREEN_PANELS } from "../screens";
import type { ScreenId } from "./screens";
import { screenDock, type ScreenDockModel } from "./studioPanels";

const docks = new Map<ScreenId, ScreenDockModel>();

export function dockOf(screen: ScreenId): ScreenDockModel {
  let dock = docks.get(screen);
  if (!dock) docks.set(screen, (dock = screenDock(screen, SCREEN_PANELS[screen])));
  return dock;
}
