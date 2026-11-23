// Skinned meshes (ADR 0370; T16): what a SkinnedMeshRenderer's lifecycle does. Its render-side buffers are made by the
// skinning render feature that `features/skinning/register.ts` registers, and released here. Empty until T16.
import type { SkinnedMeshRenderer } from "../components/SkinnedMeshRenderer";
import type { LifecycleHooks } from "../lifecycle";

/** @internal A SkinnedMeshRenderer's lifecycle (T16: release its render resources on detach). */
export const skinnedMeshHooks: LifecycleHooks<SkinnedMeshRenderer> = {};
