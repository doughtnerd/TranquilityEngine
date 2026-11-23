// What each runtime feature's registration seam gets (`features/<feature>/register.ts`): the plugin's runtime context and
// which optional dependencies (ADR 0374) are active for this activation. `activate()` (`index.ts`) calls every seam once,
// in a fixed order, and the plugin activates again when an optional dependency comes or goes, so a seam registers its
// integration only when `on.physics` / `on.audio` say so.
import type { RuntimePluginContext } from "../../runtimeContext";

/** @internal The optional dependencies active for this activation. */
export interface AnimationIntegrations {
  /** `myco.physics` is active: root motion into CharacterControllers and RigidBodies, grounder rays, predicted root motion, ragdolls. */
  readonly physics: boolean;
  /** `myco.audio` is active: musical timing, `audio` tracks. */
  readonly audio: boolean;
}

/** @internal One feature's registration seam. */
export type FeatureRegistration = (context: RuntimePluginContext, on: AnimationIntegrations) => void;
