// Registration seam: playback (T17). Code-first playback's per-World state (plays, promises, the implicit graph) lives in
// `../instances.ts` and `./plays.ts`, made by the components' lifecycle; this seam records whether the physics plugin
// is active for this activation (ADR 0374: read at activation), which the `characterController` and `rigidBody` root
// motion modes need. `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";
import { setRootMotionPhysics } from "./rootMotion";

/** @internal */
export function registerPlayback(_context: RuntimePluginContext, on: AnimationIntegrations): void {
  setRootMotionPhysics(on.physics);
}
