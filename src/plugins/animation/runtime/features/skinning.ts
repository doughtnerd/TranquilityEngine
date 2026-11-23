// Skinned meshes (ADR 0370; T16): what a SkinnedMeshRenderer's lifecycle does. Its render-side draws are made by the
// skinning render feature that `features/skinning/register.ts` registers (`skinning/sync.ts`: created at the renderer's
// sync once the model has loaded, hidden while inactive), and released here when the component goes.
import type { SkinnedMeshRenderer } from "../components/SkinnedMeshRenderer";
import type { LifecycleHooks } from "../lifecycle";

/** @internal A SkinnedMeshRenderer's lifecycle: on detach, the renderer frees its skinned draws (ADR 0130 `release`). */
export const skinnedMeshHooks: LifecycleHooks<SkinnedMeshRenderer> = {
  detach(c) {
    c._world.render?.release(c);
  },
};
