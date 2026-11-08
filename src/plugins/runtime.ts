// First-party plugins' runtime halves (ADR 0133, 0135). The player, the dedicated server and the editor
// (its World and Play) activate this list with `activateRuntimePlugins` before `Engine.create`; nothing
// here may import from `src/editor/` or a plugin's `editor/` folder.
import { materialsRuntimePlugin } from "./materials/runtime";
import { navigationRuntimePlugin } from "./navigation/runtime";
import { particlesRuntimePlugin } from "./particles/runtime";
import { physics2dRuntimePlugin } from "./physics2d/runtime";
import { physics3dRuntimePlugin } from "./physics3d/runtime";
import { resolveEnabledPlugins } from "./enabled";
import type { RuntimePlugin } from "./runtimeContext";
import { skyRuntimePlugin } from "./sky/runtime";
import { tilemapsRuntimePlugin } from "./tilemaps/runtime";

export const RUNTIME_PLUGINS: readonly RuntimePlugin[] = [materialsRuntimePlugin, skyRuntimePlugin, particlesRuntimePlugin, physics2dRuntimePlugin, physics3dRuntimePlugin, navigationRuntimePlugin, tilemapsRuntimePlugin];

export { activateRuntimePlugins, deactivateRuntimePlugin, isRuntimePluginActive, pluginOfComponent, runtimePluginManifest, syncRuntimePlugins, type RuntimePlugin, type RuntimePluginContext } from "./runtimeContext";

/** The enabled runtime plugins' names for a project's `plugins.disabled` (ADR 0133): what the player, the server and Play activate. */
export const enabledRuntimePlugins = (disabled?: Iterable<string>): Set<string> => resolveEnabledPlugins(RUNTIME_PLUGINS.map((p) => p.manifest), disabled);
