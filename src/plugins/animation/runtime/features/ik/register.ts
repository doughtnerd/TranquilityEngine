// Registration seam: ik (T40t). The rig stack's per-frame inputs (IK targets, the character frame, rig LOD, teleport
// resets) are written by `animation.Gather` (`./gather.ts`) and need nothing registered; grounder rays are cast through
// the physics plugin's public ray API only while `on.physics` (`./physics.ts` loads it with `import()`, D113).
// `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";
import { setRigPhysics } from "./physics";

/** @internal */
export function registerIK(_context: RuntimePluginContext, on: AnimationIntegrations): void {
  setRigPhysics(on.physics);
}
