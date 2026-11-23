// Which skeleton a Ragdoll builds on, as the editor finds it (ADR 0375: "the skeleton an Animator on its node (or above it)
// animates"; T55): the first Skeleton on the Ragdoll's node or below it (depth first), else the first one under each ancestor
// in turn (the Animator's node binds the hierarchy under it). Works on nodes of the Editor World and of a play World alike.
import type { GameObject } from "../../../../engine/scene/GameObject";
import { Skeleton } from "../../../animation/runtime";

/** The first Skeleton on `node` or below it, depth first. */
function skeletonUnder(node: GameObject): { node: GameObject; skeleton: Skeleton } | null {
  const own = node.getComponent(Skeleton);
  if (own) return { node, skeleton: own };
  for (const child of node.children) {
    const found = skeletonUnder(child);
    if (found) return found;
  }
  return null;
}

/** The Skeleton `ragdollNode`'s Ragdoll builds on and its node, or null when there is none. */
export function findRigSkeleton(ragdollNode: GameObject): { node: GameObject; skeleton: Skeleton } | null {
  for (let n: GameObject | null = ragdollNode; n; n = n.parent) {
    const found = skeletonUnder(n);
    if (found) return found;
  }
  return null;
}
