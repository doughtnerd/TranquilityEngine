/**
 * @internal How 3D colliders size themselves (ADR 0045), shared by the physics backend and the
 * editor's collider gizmos so the two always agree:
 *
 * - box: `size` × the node's world scale, per axis;
 * - sphere: `radius` × the largest world scale axis;
 * - capsule: `radius` × the larger of the two axes across it, and `height` × the scale along it,
 *   never shorter than the capsule's diameter;
 * - every shape sits at `center` × world scale, turned with the node.
 *
 * `shapeSize3D` is what the physics world builds and the gizmo draws: the sizes above, never thinner
 * than `MIN_SHAPE_SIZE`. `shape2d.ts` is the 2D half (ADR 0288).
 */
export type V3 = [number, number, number];

export const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

const abs3 = (s: readonly number[]): V3 => [Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2])];

/** A box's half extents in world units. */
export function boxHalfExtents(size: readonly number[], scale: readonly number[]): V3 {
  const s = abs3(scale);
  return [Math.abs(size[0] * s[0]) / 2, Math.abs(size[1] * s[1]) / 2, Math.abs(size[2] * s[2]) / 2];
}

/** A sphere's radius in world units. */
export function sphereRadius(radius: number, scale: readonly number[]): number {
  const s = abs3(scale);
  return Math.abs(radius) * Math.max(s[0], s[1], s[2]);
}

/** A capsule's radius and the half length of its straight part, in world units, along `axis` (0 x, 1 y, 2 z). */
export function capsuleSize(radius: number, height: number, axis: 0 | 1 | 2, scale: readonly number[]): { radius: number; halfHeight: number } {
  const s = abs3(scale);
  const across = Math.max(...s.filter((_, i) => i !== axis));
  const r = Math.abs(radius) * across;
  const total = Math.abs(height) * s[axis];
  return { radius: r, halfHeight: Math.max(0, total / 2 - r) };
}

/** The thinnest a physics backend builds a collider, in world units (ADR 0288): a zero-sized one still collides as a speck. */
export const MIN_SHAPE_SIZE = 1e-4;

/**
 * A sized 3D collider's fields, in local units; a capsule lies along `axis` (0 x, 1 y, 2 z), and an `upright` one
 * (a character controller's) doesn't turn with its node.
 */
export type SizedShapeFields3D =
  | { readonly kind: "box"; readonly size: readonly number[] }
  | { readonly kind: "sphere"; readonly radius: number }
  | { readonly kind: "capsule"; readonly radius: number; readonly height: number; readonly axis: 0 | 1 | 2; readonly upright?: boolean };

/**
 * A 3D collider's shape as its class describes it (ADR 0305): a sized shape, or a mesh (`mesh`, an asset reference;
 * empty takes the node's MeshRenderer's) exact or wrapped in its convex hull. Its rebuild signature is
 * `shapeSignature(fields)` (`shape2d.ts`).
 */
export type ShapeFields3D = SizedShapeFields3D | { readonly kind: "mesh"; readonly mesh: string; readonly convex: boolean };

/** The collider as the physics backend builds it (world units): the sizes above, every one at least `MIN_SHAPE_SIZE` (a capsule's straight part may be zero). */
export type ShapeSize3D =
  | { readonly kind: "box"; readonly halfExtents: V3 }
  | { readonly kind: "sphere"; readonly radius: number }
  | { readonly kind: "capsule"; readonly radius: number; readonly halfHeight: number; readonly axis: 0 | 1 | 2 };

const atLeast = (v: number) => Math.max(v, MIN_SHAPE_SIZE);

/** A collider's world size on a node of world scale `scale`, as the 3D physics world builds it and the gizmo draws it. */
export function shapeSize3D(shape: SizedShapeFields3D, scale: readonly number[]): ShapeSize3D {
  switch (shape.kind) {
    case "box":
      return { kind: "box", halfExtents: boxHalfExtents(shape.size, scale).map(atLeast) as V3 };
    case "sphere":
      return { kind: "sphere", radius: atLeast(sphereRadius(shape.radius, scale)) };
    case "capsule": {
      const { radius, halfHeight } = capsuleSize(shape.radius, shape.height, shape.axis, scale);
      return { kind: "capsule", radius: atLeast(radius), halfHeight, axis: shape.axis };
    }
  }
}

/** The shape's offset from the node's origin in the node's (unscaled, turned) frame: `center` × world scale. */
export function scaledCenter(center: readonly number[], scale: readonly number[]): V3 {
  return [center[0] * scale[0], center[1] * scale[1], center[2] * scale[2]];
}
