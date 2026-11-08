import { physics2DOf } from "./physics2dSystems";
import { Component } from "../../../engine/core/Component";
import { Vector2 } from "../../../engine/core/math";
import { PlainObject, component, field } from "../../../engine/core/registry";
import type { GameObject } from "../../../engine/scene/GameObject";
import type { ColliderHandleState } from "./Physics2DWorld";
import { RigidBody2D } from "./RigidBody2D";

import type { PhysicsMaterial, PhysicsMaterial2D } from "../../../engine/physics/types";
export type { PhysicsMaterial, PhysicsMaterial2D };

/** Base class for 2D colliders (ADR 0005). Without a RigidBody2D on the node or an ancestor, a collider is static. */
export abstract class Collider2D extends Component {
  /** Offset from the node's origin, in local units. */
  @field(Vector2) center = new Vector2(0, 0);
  /** Triggers report overlaps (onTriggerEnter/Exit) but don't collide. */
  @field(Boolean) isTrigger = false;
  /** Collision layer name from project settings. */
  @field(String, { choices: (s) => s.physics.layers }) layer = "Default";
  @field(PlainObject) material: PhysicsMaterial = { friction: 0.5, bounciness: 0 };

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
    physics2DOf(this._world)?.releaseCollider(this);
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

/** A collider outline point in local units, as `[x, y]` (scene files store points the same way). */
export type ColliderPoint2D = [number, number];

/**
 * A polygon collider (ADR 0039): the outline through `points`, in order, closed back to the first.
 * Points are in local units, scaled, rotated and offset (`center`) with the node like the other
 * colliders. Either winding works. A concave polygon is split into convex parts; one that crosses
 * itself collides along its outline only.
 */
@component("engine.PolygonCollider2D")
export class PolygonCollider2D extends Collider2D {
  /** The outline's vertices, at least 3. Changes (even in place) rebuild the shape on the next physics step. */
  @field(PlainObject) points: ColliderPoint2D[] = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];

  override _shapeSignature(): string {
    return `polygon:${JSON.stringify(this.points)}`;
  }
}

/**
 * An edge collider (ADR 0039): an open polyline through `points`, in local units. It has no
 * inside, so it suits ground, walls and slopes.
 */
@component("engine.EdgeCollider2D")
export class EdgeCollider2D extends Collider2D {
  /** The line's vertices, at least 2. Changes (even in place) rebuild the shape on the next physics step. */
  @field(PlainObject) points: ColliderPoint2D[] = [
    [-0.5, 0],
    [0.5, 0],
  ];

  override _shapeSignature(): string {
    return `edge:${JSON.stringify(this.points)}`;
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
