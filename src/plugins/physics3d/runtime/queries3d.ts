/**
 * 3D shape casts and overlap queries on a Rapier world (backend only; the `Physics` facade reaches it
 * through `Physics3DWorld.queries`). Everything in and out is plain world-space data.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import type { Collider } from "./Collider";

type V3 = { x: number; y: number; z: number };
type Q4 = { x: number; y: number; z: number; w: number };

/** @internal */
export type QueryShape3D =
  | { kind: "sphere"; radius: number }
  | { kind: "box"; halfExtents: V3 }
  | { kind: "capsule"; radius: number; halfHeight: number };

/** @internal */
export class Queries3D {
  constructor(
    private readonly rapier: RAPIER.World,
    private readonly colliderFor: (handle: number) => Collider | undefined,
    private readonly groupsFor: (layer: string) => number,
  ) {}

  private shapeOf(s: QueryShape3D): RAPIER.Shape {
    switch (s.kind) {
      case "sphere": return new RAPIER.Ball(s.radius);
      case "box": return new RAPIER.Cuboid(s.halfExtents.x, s.halfExtents.y, s.halfExtents.z);
      case "capsule": return new RAPIER.Capsule(s.halfHeight, s.radius);
    }
  }

  private groups(layers?: string[]): number | undefined {
    if (!layers?.length) return undefined;
    return (0xffff << 16) | layers.reduce((m, l) => m | (this.groupsFor(l) >>> 16), 0);
  }

  /** Sweep a shape along `direction`; returns the first collider hit, or null. */
  castShape(shape: QueryShape3D, position: V3, rotation: Q4, direction: V3, maxDistance: number, layers?: string[]) {
    const len = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const vel = { x: direction.x / len, y: direction.y / len, z: direction.z / len };
    const hit = this.rapier.castShape(
      { x: position.x, y: position.y, z: position.z },
      { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      vel,
      this.shapeOf(shape),
      0,
      maxDistance,
      true,
      undefined,
      this.groups(layers),
    );
    if (!hit) return null;
    const collider = this.colliderFor(hit.collider.handle);
    if (!collider) return null;
    // World.castShape reports witness1/normal1 on the hit collider in world space.
    const w = hit.witness1, n = hit.normal1;
    return { collider, point: { x: w.x, y: w.y, z: w.z }, normal: { x: n.x, y: n.y, z: n.z }, distance: hit.time_of_impact };
  }

  /** Every collider intersecting the shape. */
  overlap(shape: QueryShape3D, position: V3, rotation: Q4, layers?: string[]): Collider[] {
    const found = new Set<Collider>();
    this.rapier.intersectionsWithShape(
      { x: position.x, y: position.y, z: position.z },
      { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      this.shapeOf(shape),
      (c) => {
        const col = this.colliderFor(c.handle);
        if (col) found.add(col);
        return true;
      },
      undefined,
      this.groups(layers),
    );
    return [...found];
  }

  /** Every collider containing the point. */
  overlapPoint(point: V3, layers?: string[]): Collider[] {
    const found = new Set<Collider>();
    this.rapier.intersectionsWithPoint(
      { x: point.x, y: point.y, z: point.z },
      (c) => {
        const col = this.colliderFor(c.handle);
        if (col) found.add(col);
        return true;
      },
      undefined,
      this.groups(layers),
    );
    return [...found];
  }
}
