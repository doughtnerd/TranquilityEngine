// First-party plugins' runtime halves (ADR 0133, 0135). The player, the dedicated server and the editor
// (its World and Play) activate this list with `activateRuntimePlugins` before `Engine.create`; nothing
// here may import from `src/editor/` or a plugin's `editor/` folder.
import { materialsRuntimePlugin } from "./materials/runtime";
import type { RuntimePlugin } from "./runtimeContext";
import { skyRuntimePlugin } from "./sky/runtime";

export const RUNTIME_PLUGINS: readonly RuntimePlugin[] = [materialsRuntimePlugin, skyRuntimePlugin];

export { activateRuntimePlugins, deactivateRuntimePlugin, isRuntimePluginActive, type RuntimePlugin, type RuntimePluginContext } from "./runtimeContext";
