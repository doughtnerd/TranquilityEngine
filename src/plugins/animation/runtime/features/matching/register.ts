// Registration seam: matching (T42t). Registers pose databases and the trajectory input from CharacterControllers (when `on.physics`).
// `activate()` (`../../index.ts`) calls it once per activation; empty until T42t.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerMatching(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
