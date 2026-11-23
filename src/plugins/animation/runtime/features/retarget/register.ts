// Registration seam: retarget (T41t). Registers skeleton profiles at run time and the retarget node family.
// `activate()` (`../../index.ts`) calls it once per activation; empty until T41t.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerRetarget(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
