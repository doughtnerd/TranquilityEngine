// Registration seam: ik (T40t). Registers the rig stack's per-World inputs; grounder rays through the physics plugin's public ray API when `on.physics`.
// `activate()` (`../../index.ts`) calls it once per activation; empty until T40t.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerIK(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
