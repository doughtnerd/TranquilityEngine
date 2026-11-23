// Registration seam: retarget (T41t). Skeleton profiles and retarget maps are made when a graph with a RETARGET node
// loads (`../graph/asset.ts` → `./maps.ts`: profiles through `profile_decode`, bone maps from the model's import or
// `guess_bone_map`, the map through `retarget_map_create`); the retarget node family itself is the core's and the
// compiler's (`engine/animation/graphNodes/retarget.ts`). Nothing is registered per activation.
// `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerRetarget(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
