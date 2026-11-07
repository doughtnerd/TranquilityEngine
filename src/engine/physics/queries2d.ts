/**
 * 2D shape casts and overlap queries on a Rapier world (backend only; the `Physics2D` facade reaches it
 * through `Physics2DWorld.queries`). Everything in and out is plain world-space data; rotation is radians.
 */
import RAPIER from "@dimforge/rapier2d-compat";
import type { Collider2D } from "./Collider2D";

type V2 = { x: number; y: number };

/** @internal */
export type QueryShape2D =
  | { kind: "circle"; radius: number }
  | { kind: "box"; halfExtents: V2 }
  | { kind: "capsule"; radius: number; halfHeight: number };

/** @internal */
export class Queries2D {
  constructor(
    private readonly rapier: RAPIER.World,
    private readonly colliderFor: (handle: number) => Collider2D | undefined,
    private readonly groupsFor: (layer: string) => number,
  ) {}

  private shapeOf(s: QueryShape2D): RAPIER.Shape {
    switch (s.kind) {
      case "circle": return new RAPIER.Ball(s.radius);
      case "box": return new RAPIER.Cuboid(s.halfExtents.x, s.halfExtents.y);
      case "capsule": return new RAPIER.Capsule(s.halfHeight, s.radius);
    }
  }

  private groups(layers?: string[]): number | undefined {
    if (!layers?.length) return undefined;
    return (0xffff << 16) | layers.reduce((m, l) => m | (this.groupsFor(l) >>> 16), 0);
  }

  /** Sweep a shape along `direction`; returns the first collider hit, or null. */
  castShape(shape: QueryShape2D, position: V2, rotation: number, direction: V2, maxDistance: number, layers?: string[]) {
    const len = Math.hypot(direction.x, direction.y) || 1;
    const hit = this.rapier.castShape(
      { x: position.x, y: position.y },
      rotation,
      { x: direction.x / len, y: direction.y / len },
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
    return { collider, point: { x: w.x, y: w.y }, normal: { x: n.x, y: n.y }, distance: hit.time_of_impact };
  }

  /** Every collider intersecting the shape. */
  overlap(shape: QueryShape2D, position: V2, rotation: number, layers?: string[]): Collider2D[] {
    const found = new Set<Collider2D>();
    this.rapier.intersectionsWithShape(
      { x: position.x, y: position.y },
      rotation,
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
  overlapPoint(point: V2, layers?: string[]): Collider2D[] {
    const found = new Set<Collider2D>();
    this.rapier.intersectionsWithPoint(
      { x: point.x, y: point.y },
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
