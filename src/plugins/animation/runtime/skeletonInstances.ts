// What render sync reads of an animated skeleton (ADR 0370; the T16/T17 contract): the core instance animating a node
// with a Skeleton component, its model-space skinning matrices this frame, and a version that bumps when they may have
// changed. A skeleton is animated by the Animator on its node or above it (`features/instances.ts`). Every World kind
// computes the matrices, servers included: the core has no switch to skip them yet, and BoneAttachments (hit volumes)
// need the model-space pose there anyway; a server simply never reads them through this module.
import type { World } from "../../../engine/core/World";
import type { GameObject } from "../../../engine/scene/GameObject";
import { skeletonOnNode, type AnimatorRuntime } from "./features/instances";
import { MATRIX_FLOATS } from "./wasm/wire/core";

function animating(world: World, skeleton: GameObject): AnimatorRuntime | null {
  const rt = skeletonOnNode(world, skeleton)?.animator ?? null;
  return rt && rt.instance && rt.ns?.open ? rt : null;
}

/** @internal The core instance animating `skeleton` (a node with a Skeleton component), or 0. */
export function instanceForSkeleton(world: World, skeleton: GameObject): number {
  return animating(world, skeleton)?.instance ?? 0;
}

/** @internal This frame's model-space skinning matrices for `skeleton` (row-major 3×4, 12 floats per bone, model × inverse bind, D10), a view valid until the next core call; null when not animated. */
export function skinningMatrices(world: World, skeleton: GameObject): Float32Array | null {
  const rt = animating(world, skeleton);
  const bones = rt?.skeleton?.info?.bones ?? 0;
  if (!rt || !rt.evaluated || !bones) return null;
  const core = rt.ns!.core;
  const at = core.matrixOffset(rt.instance);
  return core.views().matrices.subarray(at, at + bones * MATRIX_FLOATS);
}

/** @internal Bumps each time `skeleton`'s matrices change (for render sync to skip unchanged ones). */
export function skinningVersion(world: World, skeleton: GameObject): number {
  return skeletonOnNode(world, skeleton)?.animator?.version ?? 0;
}
