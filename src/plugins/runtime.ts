// First-party plugins' runtime halves (ADR 0133, 0135). The player, the dedicated server and the editor
// (its World and Play) activate this list with `activateRuntimePlugins` before `Engine.create`; nothing
// here may import from `src/editor/` or a plugin's `editor/` folder.
import { materialsRuntimePlugin } from "./materials/runtime";
import { navigationRuntimePlugin } from "./navigation/runtime";
import { particlesRuntimePlugin } from "./particles/runtime";
import { physicsRuntimePlugin } from "./physics/runtime";
import { physicsRapierRuntimePlugin } from "./physics-rapier/runtime";
import { resolveEnabledPlugins } from "./enabled";
import type { RuntimePlugin } from "./runtimeContext";
import { skyRuntimePlugin } from "./sky/runtime";
import { tilemapsRuntimePlugin } from "./tilemaps/runtime";
import { spritesRuntimePlugin } from "./sprites/runtime";
import { meshesRuntimePlugin } from "./meshes/runtime";
import { waterRuntimePlugin } from "./water/runtime";
import { uiRuntimePlugin } from "./ui/runtime";
import { environmentRuntimePlugin } from "./environment/runtime";
import { postProcessingRuntimePlugin } from "./post-processing/runtime";

// Render features register in this order; inside a phase their `after` constraints decide (ADR 0135, 0140),
// so the order here only breaks ties: content runs sprites, tilemaps, meshes in any order of this list.
export const RUNTIME_PLUGINS: readonly RuntimePlugin[] = [
  materialsRuntimePlugin,
  skyRuntimePlugin,
  spritesRuntimePlugin,
  meshesRuntimePlugin,
  particlesRuntimePlugin,
  physicsRuntimePlugin,
  physicsRapierRuntimePlugin,
  navigationRuntimePlugin,
  tilemapsRuntimePlugin,
  waterRuntimePlugin,
  uiRuntimePlugin,
  environmentRuntimePlugin,
  postProcessingRuntimePlugin,
];

export { activateRuntimePlugins, deactivateRuntimePlugin, isRuntimePluginActive, pluginOfComponent, runtimePluginManifest, syncRuntimePlugins, type RuntimePlugin, type RuntimePluginContext } from "./runtimeContext";

/** The enabled runtime plugins' names for a project's `plugins.disabled` (ADR 0133): what the player, the server and Play activate. */
export const enabledRuntimePlugins = (disabled?: Iterable<string>): Set<string> => resolveEnabledPlugins(RUNTIME_PLUGINS.map((p) => p.manifest), disabled);
