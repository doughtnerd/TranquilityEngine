// Registration seam: graph (T32). Registers graph assets, the blackboard, computed parameters and `animatorParams`.
// `activate()` (`../../index.ts`) calls it once per activation; empty until T32.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerGraph(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
