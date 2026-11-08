/**
 * 2D collision shape sources (ADR 0136). A Component that can describe 2D collision shapes (a Tilemap's
 * tiles today; a sprite outline or a procedural level tomorrow) implements `CollisionShapeSource2D`, and a
 * 2D collider on the same node (Physics 2D's `TilemapCollider2D`) builds colliders from whatever source it
 * finds. Neither side knows the other: physics plugins and content plugins meet here, in core.
 * No physics engine types (ADR 0010).
 */
import type { Component } from "../core/Component";
import type { GameObject } from "../scene/GameObject";

/** How solid whole-cell shapes merge: into rectangles (solid) or outlines around each region (hollow). */
export type ShapeMerge2D = "rectangles" | "outline";

/** An axis-aligned rectangle in shape units. */
export interface ShapeRect2D {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Collision shapes in shape units; `unit` scales them into the source node's local space. */
export interface CollisionShapes2D {
  /** One shape unit's size in the node's local units (a tilemap's cell size). */
  unit: { x: number; y: number };
  /** Solid rectangles. */
  boxes: ShapeRect2D[];
  /** Closed outlines with the solid on the left of each edge (counter-clockwise outside, clockwise around holes). */
  loops: [number, number][][];
  /** Convex solid polygons. */
  polygons: [number, number][][];
  /** One-way platform rectangles: bodies pass up through them and land on top. */
  oneWay: ShapeRect2D[];
  /** Convex one-way polygons. */
  oneWayPolygons: [number, number][][];
}

/** A Component that offers 2D collision shapes to whatever 2D collider sits on its node. */
export interface CollisionShapeSource2D {
  /** Changes whenever the shapes `collisionShapes` would give change (cells, settings, the asset they come from). */
  collisionSignature(): string;
  /** The shapes now, or null while they can't be known yet (an asset still loading). */
  collisionShapes(merge: ShapeMerge2D): CollisionShapes2D | null;
}

/** Whether `c` offers 2D collision shapes. */
export function isCollisionShapeSource2D(c: unknown): c is Component & CollisionShapeSource2D {
  const s = c as Partial<CollisionShapeSource2D> | null;
  return !!s && typeof s.collisionSignature === "function" && typeof s.collisionShapes === "function";
}

/** The first Component on `node` (not its children) that offers 2D collision shapes, or null. */
export function findShapeSource2D(node: GameObject): (Component & CollisionShapeSource2D) | null {
  for (const c of node.world._componentsOf(node.entity)) if (isCollisionShapeSource2D(c)) return c;
  return null;
}
