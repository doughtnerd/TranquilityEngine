import { component, field, registerComponentAlias } from "../../../engine/core/registry";
import { Collider2D } from "./Collider2D";
import { findShapeSource2D, type CollisionShapeSource2D, type ShapeMerge2D } from "../../../engine/physics/shapeSource2D";
import type { Component } from "../../../engine/core/Component";
import type { ShapeFields2D } from "../../../engine/physics/shape2d";
import type { Dim2 } from "./backend";
import type { ShapeColliderState } from "./core/state";
import type { RigidBody2D } from "./RigidBody2D";

/**
 * Collision built from the 2D shapes another Component on the same node offers (ADR 0105, 0136, 0423): any
 * `CollisionShapeSource2D`, such as a Tilemap (each tile's collision from its tileset: `"full"`,
 * `"oneWay"` or a polygon; layers with `collision: false` skipped). Whole-cell shapes merge into a few
 * rectangles (`"rectangles"`, solid, the default) or into outlines around each solid region
 * (`"outline"`, hollow: only the edges collide); seams between merged parts don't snag sliding bodies.
 * One-way shapes let bodies pass up through them and land on top; `oneWay` makes every shape one-way.
 * With no shape source on the node it builds nothing. Without a RigidBody2D on the node or an ancestor the
 * colliders are static. Until ADR 0423 it was `TilemapCollider2D` (`engine.TilemapCollider2D`, read as this).
 */
@component("engine.ShapeCollider2D")
export class ShapeCollider2D extends Collider2D {
  @field(String, { choices: ["rectangles", "outline"], animatable: false }) mode: ShapeMerge2D = "rectangles";

  /** @internal */ _shapeState: ShapeColliderState<Dim2, RigidBody2D> | null = null;

  /** The Component whose shapes collide: the first on this node that offers 2D collision shapes (a Tilemap, say), or null. */
  get source(): (Component & CollisionShapeSource2D) | null {
    return findShapeSource2D(this.node);
  }

  override _shapeFields(): ShapeFields2D {
    return { kind: "source", merge: this.mode };
  }
}

// Scenes and prefabs written before the rename name the old id (ADR 0423).
registerComponentAlias("engine.TilemapCollider2D", "engine.ShapeCollider2D");
