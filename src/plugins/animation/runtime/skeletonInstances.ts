// PLACEHOLDER (T16, only so the skinning feature compiles): T17 owns this file and replaces it at merge (the coordinator
// resolves in T17's favour). Same signatures as T17's contract; no Skeleton has a pose here, so skinned meshes draw their
// bind pose (identity palette) until T17 lands.
import type { World } from "../../../engine/core/World";
import type { GameObject } from "../../../engine/scene/GameObject";

/** @internal The core instance evaluating `skeleton`'s pose, or -1 (placeholder: none). */
export function instanceForSkeleton(_world: World, _skeleton: GameObject): number {
  return -1;
}

/** @internal `skeleton`'s skinning palette: row-major 3×4, 12 floats a bone, model × inverse bind; null without a pose (placeholder: always). */
export function skinningMatrices(_world: World, _skeleton: GameObject): Float32Array | null {
  return null;
}

/** @internal Bumped whenever `skinningMatrices` changes (placeholder: never). */
export function skinningVersion(_world: World, _skeleton: GameObject): number {
  return 0;
}
