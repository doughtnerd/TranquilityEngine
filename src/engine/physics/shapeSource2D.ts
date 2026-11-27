/**
 * 2D collision shape sources (ADR 0136). A Component that can describe 2D collision shapes (a Tilemap's
 * tiles today; a sprite outline or a procedural level tomorrow) implements `CollisionShapeSource2D`, and a
 * 2D collider on the same node (Physics 2D's `ShapeCollider2D`) builds colliders from whatever source it
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

/**
 * One chunk of whole solid cells (ADR 0444): a square block of `CollisionCells2D.chunkSize` cells on a side. Flag `i`
 * of `solid` is cell (cx·size + i % size, cy·size + ⌊i / size⌋) of its group, row by row from the chunk's bottom-left.
 */
export interface CollisionCellChunk2D {
  /** The chunk's position, in chunks. */
  readonly cx: number;
  readonly cy: number;
  /** Changes whenever `solid` changes, so a collider rebuilds only the chunks that changed. */
  readonly version: string;
  /** size × size flags: nonzero is a solid cell. */
  readonly solid: Uint8Array;
}

/** Cells that share one lattice (ADR 0444): a tilemap's colliding layers with the same offset. */
export interface CollisionCellGroup2D {
  /** Tells the group apart from one call to the next. */
  readonly key: string;
  /** Where cell (0, 0)'s bottom-left corner is, in shape units. */
  readonly offset: { readonly x: number; readonly y: number };
  /** Its chunks with at least one solid cell. */
  readonly chunks: readonly CollisionCellChunk2D[];
}

/**
 * Whole solid cells of a square grid, per chunk (ADR 0444), for colliders that keep cells as cells (voxels) and edit
 * them in place. Cell (x, y) of a group covers its offset + (x..x+1, y..y+1) shape units.
 */
export interface CollisionCells2D {
  /** One shape unit's size in the node's local units (a tilemap's cell size). */
  readonly unit: { readonly x: number; readonly y: number };
  /** Cells on a chunk's side. */
  readonly chunkSize: number;
  readonly groups: readonly CollisionCellGroup2D[];
}

/** What `collisionShapes` leaves out. */
export interface CollisionShapeOptions2D {
  /**
   * ADR 0444: leave out the whole cells `collisionCells()` offers (their rectangles, or their outlines in `"outline"`
   * mode), for a collider that builds those from the cells. Nothing is left out when the source offers no cells.
   */
  readonly withoutCells?: boolean;
}

/** A Component that offers 2D collision shapes to whatever 2D collider sits on its node. */
export interface CollisionShapeSource2D {
  /** Changes whenever the shapes `collisionShapes` (or the cells `collisionCells`) would give change (cells, settings, the asset they come from). */
  collisionSignature(): string;
  /** The shapes now, or null while they can't be known yet (an asset still loading). */
  collisionShapes(merge: ShapeMerge2D, options?: CollisionShapeOptions2D): CollisionShapes2D | null;
  /**
   * ADR 0444, optional: the whole solid cells of a square grid per chunk, or null when the source has none to offer
   * that way (another grid, an asset still loading). A source that offers them takes `withoutCells` too.
   */
  collisionCells?(): CollisionCells2D | null;
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
