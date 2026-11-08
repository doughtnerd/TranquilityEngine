// The Navigation plugin's runtime half (ADR 0065, 0135): its Components, its fixed-step systems and the
// World service that loads the navigation WebAssembly module when a World that simulates navigation
// first needs it (a scene with navigation components, or one attaching later). `myco` (`src/myco.ts`)
// exports the public parts from here; the navigation settings types stay core exports (project settings).
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder; the module loads on demand.
import type { World } from "../../../engine/core/World";
import type { RuntimePlugin } from "../../runtimeContext";
import { navigationManifest } from "../manifest";
import { NavAgent, NavAvoidanceObstacle, NavChunk, NavCostVolume, NavFlowGoal, NavGate, NavGroup, NavModifierVolume, NavObstacle, NavResolutionVolume, NavSurface, NavSurround } from "./components";
import { NAV_SYSTEMS, NAVIGATION_SERVICE, navigationOf } from "./navigationSystems";

export { NavAgent, NavAvoidanceObstacle, NavChunk, NavCostVolume, NavFlowGoal, NavGate, NavGroup, NavModifierVolume, NavObstacle, NavResolutionVolume, NavSurface, NavSurround, type NavMode, type NavPathState, type NavWaypoint } from "./components";
export { Navigation, type NavNearestPoint, type NavPathResult, type NavPathStatus, type NavRaycastHit } from "./Navigation";
export { NAVIGATION, navigationOf, type NavDebugSettings } from "./navigationSystems";

/** @internal How many navigation agents `world` has, or null while it has no navigation (the editor's play stats). */
export function navAgentCount(world: World): number | null {
  return navigationOf(world) ? world._componentsOfType(NavAgent).length : null;
}

export const navigationRuntimePlugin: RuntimePlugin = {
  manifest: navigationManifest,
  activate(context) {
    context.registerComponents([NavChunk, NavSurface, NavObstacle, NavModifierVolume, NavResolutionVolume, NavGate, NavCostVolume, NavAgent, NavGroup, NavSurround, NavFlowGoal, NavAvoidanceObstacle]);
    context.registerEngineSystems(NAV_SYSTEMS);
    context.registerWorldService(NAVIGATION_SERVICE);
  },
};
