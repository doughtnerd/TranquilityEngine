// Registration seam: physical (T44). Registers the physics rows ragdolls use; the `PHYSICAL_ANIMATION` contribution point itself needs no registration.
// `activate()` (`../../index.ts`) calls it once per activation; empty until T44.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerPhysical(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
