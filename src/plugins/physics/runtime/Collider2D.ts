import { physics2DOf } from "./systems2d";
import { Component } from "../../../engine/core/Component";
import { Vector2 } from "../../../engine/core/math";
import { PlainObject, component, field } from "../../../engine/core/registry";
import type { GameObject } from "../../../engine/scene/GameObject";
import type { Dim2 } from "./backend";
import type { ColliderState } from "./core/state";
import { RigidBody2D } from "./RigidBody2D";
import { attachedBody } from "./attachedBody";

import type { ShapeFields2D } from "../../../engine/physics/shape2d";
import type { Point2 } from "../../../engine/physics/polygon";
import { SpriteRenderer } from "../../../engine/render/components";
import { spriteOutline } from "../../../engine/render/sprites/spriteOutline";
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

  /** @internal */ _state: ColliderState<Dim2, RigidBody2D> | null = null;

  /** The body this collider is attached to: the nearest active RigidBody2D on this node or an ancestor. */
  get attachedRigidbody(): RigidBody2D | null {
    return attachedBody(this.node, RigidBody2D);
  }

  /**
   * @internal The collider's shape as its fields describe it, backend-neutral (ADR 0305): what the 2D physics world
   * builds, the collider gizmo draws, and the shape is rebuilt on (`shapeSignature`).
   */
  abstract _shapeFields(): ShapeFields2D;

  override _onDetach(): void {
    physics2DOf(this._world)?.releaseCollider(this);
  }
}

@component("engine.BoxCollider2D")
export class BoxCollider2D extends Collider2D {
  /** Width and height in local units (scaled by the node's world scale). */
  @field(Vector2) size = new Vector2(1, 1);

  override _shapeFields(): ShapeFields2D {
    return { kind: "box", size: [this.size.x, this.size.y] };
  }
}

@component("engine.CircleCollider2D")
export class CircleCollider2D extends Collider2D {
  @field(Number) radius = 0.5;

  override _shapeFields(): ShapeFields2D {
    return { kind: "circle", radius: this.radius };
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
  /**
   * Collide along the node's SpriteRenderer outline instead of `points` (ADR 0415): its slice's traced outline (the
   * Sprite Editor's, ADR 0414; the largest loop when it has several), else its rectangle. It follows the sprite, its
   * size and flips. Without a SpriteRenderer, `points`. A whole-texture sprite needs its texture's size, so a World
   * without a renderer (a server) collides along its unit quad; a slice needs only its rect.
   */
  @field(Boolean, { description: "Collide along the node's sprite outline (its slice's traced outline, else its rectangle) instead of the points." }) fromSprite = false;

  private spriteCache: { signature: string; points: ColliderPoint2D[] } | null = null;

  override _shapeFields(): ShapeFields2D {
    if (this.fromSprite) {
      const points = this.spritePoints();
      if (points) return { kind: "polygon", points };
    }
    return { kind: "polygon", points: this.points };
  }

  /** The sprite outline's points now, or null without a SpriteRenderer. */
  private spritePoints(): ColliderPoint2D[] | null {
    const r = this.node.getComponent(SpriteRenderer);
    if (!r) return null;
    const world = this._world;
    const o = spriteOutline(world, r, (path) => world.render?.textureSize?.(path) ?? null);
    if (this.spriteCache?.signature === o.signature) return this.spriteCache.points;
    let best: Point2[] | null = null, bestArea = -1;
    for (const loop of o.loops) {
      let a = 0;
      for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) a += loop[j]![0] * loop[i]![1] - loop[i]![0] * loop[j]![1];
      if (Math.abs(a) > bestArea) [best, bestArea] = [loop, Math.abs(a)];
    }
    if (!best || best.length < 3) return null;
    this.spriteCache = { signature: o.signature, points: best.map((p): ColliderPoint2D => [p[0], p[1]]) };
    return this.spriteCache.points;
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

  override _shapeFields(): ShapeFields2D {
    return { kind: "edge", points: this.points };
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
