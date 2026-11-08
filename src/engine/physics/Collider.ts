import { Component } from "../core/Component";
import { Vector3 } from "../core/math";
import { AssetRef, PlainObject, component, field } from "../core/registry";
import type { GameObject } from "../scene/GameObject";
import type { PhysicsMaterial } from "./Collider2D";
import type { ColliderHandleState3D } from "./Physics3DWorld";
import { RigidBody } from "./RigidBody";

/**
 * Base class for 3D colliders (ADR 0005, 0045). Without a RigidBody on the node or an ancestor, a
 * collider is static. Sizes are in the node's local units, scaled by its world scale.
 */
export abstract class Collider extends Component {
  /** Offset from the node's origin, in local units. */
  @field(Vector3) center = new Vector3(0, 0, 0);
  /** Triggers report overlaps (onTriggerEnter/Exit) but don't collide. */
  @field(Boolean) isTrigger = false;
  /** Collision layer name from project settings. */
  @field(String, { choices: (s) => s.physics.layers }) layer = "Default";
  @field(PlainObject) material: PhysicsMaterial = { friction: 0.5, bounciness: 0 };

  /** @internal */ _state: ColliderHandleState3D | null = null;

  /** The body this collider is attached to: the nearest active RigidBody on this node or an ancestor. */
  get attachedRigidbody(): RigidBody | null {
    for (let n: GameObject | null = this.node; n; n = n.parent) {
      const rb = n.getBehavior(RigidBody);
      if (rb && rb.isActiveAndEnabled) return rb;
    }
    return null;
  }

  /** @internal A string that changes whenever the shape must be rebuilt. */
  abstract _shapeSignature(): string;

  override _onDetach(): void {
    this._world.physics3D?.releaseCollider(this);
  }
}

/** A box, `size` across (local units). */
@component("engine.BoxCollider")
export class BoxCollider extends Collider {
  @field(Vector3) size = new Vector3(1, 1, 1);

  override _shapeSignature(): string {
    return `box:${this.size.x},${this.size.y},${this.size.z}`;
  }
}

/** A sphere; its radius is scaled by the node's largest scale axis. */
@component("engine.SphereCollider")
export class SphereCollider extends Collider {
  @field(Number) radius = 0.5;

  override _shapeSignature(): string {
    return `sphere:${this.radius}`;
  }
}

export type CapsuleDirection = "x" | "y" | "z";

/**
 * A capsule along one of the node's axes: `height` is its full length, end caps included (as in
 * Unity), never less than its diameter. The radius is scaled by the larger of the other two axes.
 */
@component("engine.CapsuleCollider")
export class CapsuleCollider extends Collider {
  @field(Number) radius = 0.5;
  @field(Number) height = 2;
  @field(String, { choices: ["x", "y", "z"] }) direction: CapsuleDirection = "y";

  override _shapeSignature(): string {
    return `capsule:${this.radius},${this.height},${this.direction}`;
  }
}

/**
 * A collider with a mesh's shape (ADR 0044, 0045): a model mesh (`asset:models/rock.obj`, or one
 * mesh of it with `#name`) or a built-in mesh. Empty uses the node's MeshRenderer's mesh.
 * `convex` wraps the mesh in its convex hull, which is what moving (dynamic) bodies need; an exact
 * (concave) mesh collides only with other shapes, so suits static level geometry.
 */
@component("engine.MeshCollider")
export class MeshCollider extends Collider {
  @field(AssetRef, { kind: "mesh" }) mesh = "";
  @field(Boolean) convex = false;

  override _shapeSignature(): string {
    return `mesh:${this.mesh}|${this.convex}`;
  }
}

/** Passed to onCollisionEnter/Exit in a 3D physics World. */
export interface Collision {
  /** The other collider. */
  readonly collider: Collider;
  /** This side's collider. */
  readonly otherCollider: Collider;
  /** The other collider's owner node. */
  readonly gameObject: GameObject;
  readonly rigidbody: RigidBody | null;
}
