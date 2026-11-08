import { component, field } from "../../../engine/core/registry";
import { Collider2D } from "./Collider2D";
import { findShapeSource2D, type CollisionShapeSource2D, type ShapeMerge2D } from "../../../engine/physics/shapeSource2D";
import type { Component } from "../../../engine/core/Component";
import type { Dim2 } from "./backend";
import type { TilemapColliderState } from "./core/state";
import type { RigidBody2D } from "./RigidBody2D";

/**
 * Collision built from the 2D shapes another Component on the same node offers (ADR 0105, 0136): any
 * `CollisionShapeSource2D`, such as a Tilemap (each tile's collision from its tileset: `"full"`,
 * `"oneWay"` or a polygon; layers with `collision: false` skipped). Whole-cell shapes merge into a few
 * rectangles (`"rectangles"`, solid, the default) or into outlines around each solid region
 * (`"outline"`, hollow: only the edges collide); seams between merged parts don't snag sliding bodies.
 * One-way shapes let bodies pass up through them and land on top. With no shape source on the node it
 * builds nothing. Without a RigidBody2D on the node or an ancestor the colliders are static.
 */
@component("engine.TilemapCollider2D")
export class TilemapCollider2D extends Collider2D {
  @field(String, { choices: ["rectangles", "outline"] }) mode: ShapeMerge2D = "rectangles";

  /** @internal */ _tileState: TilemapColliderState<Dim2, RigidBody2D> | null = null;

  /** The Component whose shapes collide: the first on this node that offers 2D collision shapes (a Tilemap, say), or null. */
  get source(): (Component & CollisionShapeSource2D) | null {
    return findShapeSource2D(this.node);
  }

  override _shapeSignature(): string {
    return `shapes:${this.mode}`;
  }
}
