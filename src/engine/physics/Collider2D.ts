import { Component } from "../core/Component";
import { Vector2 } from "../core/math";
import { PlainObject, component, field } from "../core/registry";
import type { GameObject } from "../scene/GameObject";
import type { ColliderHandleState } from "./Physics2DWorld";
import { RigidBody2D } from "./RigidBody2D";

export interface PhysicsMaterial2D {
  friction: number;
  bounciness: number;
}

/** Base class for 2D colliders (ADR 0005). Without a RigidBody2D on the node or an ancestor, a collider is static. */
export abstract class Collider2D extends Component {
  /** Offset from the node's origin, in local units. */
  @field(Vector2) center = new Vector2(0, 0);
  /** Triggers report overlaps (onTriggerEnter/Exit) but don't collide. */
  @field(Boolean) isTrigger = false;
  /** Collision layer name from project settings. */
  @field(String, { choices: (s) => s.physics.layers }) layer = "Default";
  @field(PlainObject) material: PhysicsMaterial2D = { friction: 0.5, bounciness: 0 };

  /** @internal */ _state: ColliderHandleState | null = null;

  /** The body this collider is attached to: the nearest active RigidBody2D on this node or an ancestor. */
  get attachedRigidbody(): RigidBody2D | null {
    for (let n: GameObject | null = this.node; n; n = n.parent) {
      const rb = n.getBehavior(RigidBody2D);
      if (rb && rb.isActiveAndEnabled) return rb;
    }
    return null;
  }

  /** @internal A string that changes whenever the shape must be rebuilt. */
  abstract _shapeSignature(): string;

  override _onDetach(): void {
    this.world.physics2D?.releaseCollider(this);
  }
}

@component("engine.BoxCollider2D")
export class BoxCollider2D extends Collider2D {
  /** Width and height in local units (scaled by the node's world scale). */
  @field(Vector2) size = new Vector2(1, 1);

  override _shapeSignature(): string {
    return `box:${this.size.x},${this.size.y}`;
  }
}

@component("engine.CircleCollider2D")
export class CircleCollider2D extends Collider2D {
  @field(Number) radius = 0.5;

  override _shapeSignature(): string {
    return `circle:${this.radius}`;
  }
}

/** Passed to onCollisionEnter/Exit. */
export interface Collision2D {
  /** The other collider. */
  readonly collider: Collider2D;
  /** This side's collider. */
  readonly otherCollider: Collider2D;
  /** The other collider's owner node. */
  readonly gameObject: GameObject;
  readonly rigidbody: RigidBody2D | null;
}
