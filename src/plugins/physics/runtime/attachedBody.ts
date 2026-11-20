import type { Component } from "../../../engine/core/Component";
import type { GameObject } from "../../../engine/scene/GameObject";

/**
 * The body a collider or joint on `node` belongs to: the nearest active and enabled body of `type` on the node
 * or one of its ancestors (Unity's `attachedRigidbody` rule), or null. One rule for 2D and 3D colliders and joints.
 */
export function attachedBody<B extends Component>(node: GameObject | null, type: abstract new () => B): B | null {
  for (let n = node; n; n = n.parent) {
    const body = n.getBehavior(type);
    if (body && body.isActiveAndEnabled) return body;
  }
  return null;
}
