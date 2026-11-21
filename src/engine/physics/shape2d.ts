/**
 * @internal How 2D colliders size themselves (ADR 0005, 0288), shared by the 2D physics world and the
 * editor's collider gizmos so the outline drawn is the shape simulated:
 *
 * - box: `size` × the node's world scale, per axis;
 * - circle: `radius` × the larger world scale axis;
 * - capsule (a character controller's, always upright): `radius` × |scale.x|, and `height` × |scale.y|,
 *   never shorter than the capsule's diameter;
 * - every size is at least `MIN_SHAPE_SIZE` (the 3D rule, `shape3d.ts`), so a zero-sized collider still
 *   collides as a speck;
 * - every shape sits at `center` × world scale, turned with the node (a capsule doesn't turn).
 *
 * Polygon and edge colliders take their points scaled per axis (`polygon.ts` cleans and splits them).
 * The scale is the node's 2D frame's (`scene/frame2d.ts`, ADR 0301), signed: sizes take its magnitude, while
 * `center` and points take its sign, so a mirrored node's shapes are mirrored with it.
 *
 * `ShapeFields2D` is what each 2D collider class says its shape is (`_shapeFields()`, ADR 0305): the physics
 * world builds from it, the collider gizmo draws from it, and its rebuild signature is `shapeSignature(fields)`.
 */
import { MIN_SHAPE_SIZE } from "./shape3d";

export type V2 = [number, number];

/** A sized 2D collider's fields, in local units (a capsule is a character controller's: upright). */
export type SizedShapeFields2D =
  | { readonly kind: "box"; readonly size: readonly number[] }
  | { readonly kind: "circle"; readonly radius: number }
  | { readonly kind: "capsule"; readonly radius: number; readonly height: number };

/**
 * A 2D collider's shape as its class describes it (ADR 0305), in local units: a sized shape, a polygon (closed,
 * either winding) or an edge (open) through `points`, or the shapes a 2D shape source on the node offers
 * (`shapeSource2D.ts`, merged as `merge`). Points are as the scene stores them (`[x, y]` pairs, unchecked).
 */
export type ShapeFields2D =
  | SizedShapeFields2D
  | { readonly kind: "polygon"; readonly points: readonly unknown[] }
  | { readonly kind: "edge"; readonly points: readonly unknown[] }
  | { readonly kind: "source"; readonly merge: "rectangles" | "outline" };

/** A string that changes whenever the shape fields do: what a collider's shape is rebuilt on (ADR 0305). */
export const shapeSignature = (fields: object): string => JSON.stringify(fields);

/** The shape as the physics backend builds it, in world units: a box's half extents, a circle's radius, a capsule's radius and the half length of its straight part. */
export type ShapeSize2D =
  | { readonly kind: "box"; readonly halfExtents: V2 }
  | { readonly kind: "circle"; readonly radius: number }
  | { readonly kind: "capsule"; readonly radius: number; readonly halfHeight: number };

const atLeast = (v: number) => Math.max(v, MIN_SHAPE_SIZE);

/** `shape`'s world size on a node of world scale `scale`. */
export function shapeSize2D(shape: SizedShapeFields2D, scale: readonly number[]): ShapeSize2D {
  const sx = Math.abs(scale[0]), sy = Math.abs(scale[1]);
  switch (shape.kind) {
    case "box":
      return { kind: "box", halfExtents: [atLeast(Math.abs(shape.size[0] * sx) / 2), atLeast(Math.abs(shape.size[1] * sy) / 2)] };
    case "circle":
      return { kind: "circle", radius: atLeast(Math.abs(shape.radius) * Math.max(sx, sy)) };
    case "capsule": {
      const radius = atLeast(Math.abs(shape.radius) * sx);
      return { kind: "capsule", radius, halfHeight: Math.max(0, (Math.abs(shape.height) * sy) / 2 - radius) };
    }
  }
}

/** The shape's offset from the node's origin in the node's (unscaled, turned) frame: `center` × world scale. */
export function scaledCenter2D(center: readonly number[], scale: readonly number[]): V2 {
  return [center[0] * scale[0], center[1] * scale[1]];
}
