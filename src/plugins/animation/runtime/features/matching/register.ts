// Registration seam: matching (T42t). Pose databases are bound with their graphs (`../graph/asset.ts` →
// `./posedb.ts`: the baked `*.posedb.bin`, clips through `posedb_bind`) and need nothing registered; the trajectory
// input reads CharacterControllers only while `on.physics` (`./gather.ts`). `activate()` (`../../index.ts`) calls it
// once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";
import { setMatchingPhysics } from "./gather";

/** @internal */
export function registerMatching(_context: RuntimePluginContext, on: AnimationIntegrations): void {
  setMatchingPhysics(on.physics);
}
