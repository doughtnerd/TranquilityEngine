/**
 * The public `myco` module: the core (`src/engine/index.ts`) plus every first-party plugin's public runtime surface
 * (its `runtime/public.ts`) and the third-party plugin SDK. Game code and project scripts import from here
 * (`import { Sky } from "myco"`); the engine library, the player's `myco.js` and the code editor's declarations are
 * built from it. Babylon.js, three.js, Rapier and Howler are never part of this surface.
 *
 * This file is a list, not a place to choose names: a plugin decides what it makes public in its own
 * `runtime/public.ts`, and a line here re-exports that module whole. `myco.exports.txt` records the result.
 */
export * from "./engine/index";

// A game built on the engine library has no host to activate plugins: Engine.create turns on every
// first-party runtime half unless the player, server or editor already chose a set.
import { Engine as _Engine } from "./engine/core/Engine";
import { activateGamePlugins as _activate } from "./plugins/runtime";
import { runtimePluginsChosen as _chosen } from "./plugins/runtimeContext";
_Engine._defaultPlugins = () => {
  if (!_chosen()) _activate([]);
};

// First-party plugins, in catalogue order (`src/plugins/catalogue.ts`). Materials and Physics (Rapier) have no
// public runtime names.
export * from "./plugins/sky/runtime/public";
export * from "./plugins/sprites/runtime/public";
export * from "./plugins/meshes/runtime/public";
export * from "./plugins/particles/runtime/public";
export * from "./plugins/physics/runtime/public";
export * from "./plugins/tilemaps/runtime/public";
export * from "./plugins/water/runtime/public";
export * from "./plugins/lines/runtime/public";
export * from "./plugins/decals/runtime/public";
export * from "./plugins/ui/runtime/public";
export * from "./plugins/environment/runtime/public";
export * from "./plugins/lights2d/runtime/public";
export * from "./plugins/post-processing/runtime/public";
export * from "./plugins/camera-shake/runtime/public";
export * from "./plugins/audio/runtime/public";
export * from "./plugins/subtitles/runtime/public";
export * from "./plugins/animation/runtime/public";
export * from "./plugins/ragdoll/runtime/public";

// The Navigation plugin's names are listed here only while navigation code is frozen (CLAUDE.md); they move to its
// own `runtime/public.ts` when the freeze lifts. Its settings types (`NavigationSettings`…) are core exports.
export {
  NavAgent,
  NavAvoidanceObstacle,
  NavChunk,
  NavCostVolume,
  NavFlowGoal,
  NavGate,
  NavGroup,
  NavModifierVolume,
  NavObstacle,
  NavResolutionVolume,
  NavSurface,
  NavSurround,
  Navigation,
  type NavMode,
  type NavPathState,
  type NavWaypoint,
  type NavNearestPoint,
  type NavPathResult,
  type NavPathStatus,
  type NavRaycastHit,
  type NavDebugSettings,
} from "./plugins/navigation/runtime";

// The third-party plugin SDK's runtime half. Editor halves import `myco/editor`.
export * from "./plugins/runtimeSdk";
