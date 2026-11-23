// Registration seam: physical (T44). Nothing to register: the `PHYSICAL_ANIMATION` contribution point needs no
// registration, the core's physics rows are sized when the first ragdoll attaches (`../physical.ts`), and drives are
// written by the apply sub-step (`../../stages/apply/physical.ts`) while a ragdoll plugin is connected.
// `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerPhysical(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
