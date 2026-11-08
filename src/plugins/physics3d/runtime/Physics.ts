import { physics3DOf } from "./physics3d";
import { Quaternion, Ray, Vector3, type Vec3Like } from "../../../engine/core/math";
import { World } from "../../../engine/core/World";
import type { Collider } from "./Collider";

export interface RaycastHit {
  collider: Collider;
  point: Vector3;
  normal: Vector3;
  distance: number;
}

/** A shape cast hit (ADR 0010: engine types only). `distance` is how far the shape travelled. */
export interface ShapeCastHit {
  collider: Collider;
  point: Vector3;
  normal: Vector3;
  distance: number;
}

type CastShape = { kind: "sphere"; radius: number } | { kind: "box"; halfExtents: Vec3Like } | { kind: "capsule"; radius: number; halfHeight: number };

/** Capsule from its two cap centres: centre, half height of the cylinder part and the rotation taking +Y onto p1 to p2. */
function capsuleFrom(p1: Vec3Like, p2: Vec3Like, radius: number) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y, dz = p2.z - p1.z;
  const len = Math.hypot(dx, dy, dz);
  const center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, z: (p1.z + p2.z) / 2 };
  const shape: CastShape = { kind: "capsule", radius, halfHeight: len / 2 };
  if (len < 1e-9) return { center, shape, rotation: Quaternion.identity };
  const ux = dx / len, uy = dy / len, uz = dz / len;
  // Shortest rotation from +Y to u: axis = Y x u, w = 1 + Y.u.
  const rotation = uy < -1 + 1e-9 ? new Quaternion(1, 0, 0, 0) : normalized(uz, 0, -ux, 1 + uy);
  return { center, shape, rotation };
}

function normalized(x: number, y: number, z: number, w: number): Quaternion {
  const l = Math.hypot(x, y, z, w) || 1;
  return new Quaternion(x / l, y / l, z / l, w / l);
}

function cast(center: Vec3Like, shape: CastShape, rotation: Quaternion, direction: Vec3Like, maxDistance: number, layers?: string[]): ShapeCastHit | null {
  const hit = physics().queries.castShape(shape, center, rotation, direction, maxDistance, layers);
  if (!hit) return null;
  return { collider: hit.collider, point: Vector3.from(hit.point), normal: Vector3.from(hit.normal), distance: hit.distance };
}

function physics() {
  const p = physics3DOf(World.require());
  if (!p) throw new Error('3D physics is not running. Load a scene with "settings": { "physics": "3d" }, or one with 3D bodies or colliders.');
  return p;
}

/**
 * 3D physics queries and settings for the current World (ADR 0005, 0032, 0045), the counterpart of
 * Physics2D. Each World has its own physics world; queries never see another World's colliders.
 */
export class Physics {
  static get gravity(): Vector3 {
    const g = physics().gravity;
    return new Vector3(g.x, g.y, g.z);
  }
  static set gravity(g: Vec3Like) {
    physics().gravity = { x: g.x, y: g.y, z: g.z };
  }

  /** Cast a ray; optionally restrict hits to the named layers. */
  static raycast(origin: Vec3Like, direction: Vec3Like, maxDistance?: number, layers?: string[]): RaycastHit | null;
  /** Cast a `Ray`, such as `camera.screenPointToRay(Input.mousePosition)` (ADR 0073). */
  static raycast(ray: Ray, maxDistance?: number, layers?: string[]): RaycastHit | null;
  static raycast(a: Vec3Like | Ray, b?: Vec3Like | number, c?: number | string[], d?: string[]): RaycastHit | null {
    let origin: Vec3Like, direction: Vec3Like, maxDistance: number, layers: string[] | undefined;
    if (a instanceof Ray) {
      origin = a.origin;
      direction = a.direction;
      maxDistance = (b as number | undefined) ?? Number.MAX_VALUE;
      layers = c as string[] | undefined;
    } else {
      origin = a;
      direction = b as Vec3Like;
      maxDistance = (c as number | undefined) ?? Number.MAX_VALUE;
      layers = d;
    }
    const hit = physics().raycast(origin, direction, maxDistance, layers);
    if (!hit) return null;
    return { collider: hit.collider, point: Vector3.from(hit.point), normal: Vector3.from(hit.normal), distance: hit.distance };
  }

  /** Sweep a sphere along `direction`; returns the first collider hit. */
  static sphereCast(origin: Vec3Like, radius: number, direction: Vec3Like, maxDistance = Number.MAX_VALUE, layers?: string[]): ShapeCastHit | null {
    return cast(origin, { kind: "sphere", radius }, Quaternion.identity, direction, maxDistance, layers);
  }

  /** Sweep a box (centre, half extents, optional orientation) along `direction`. */
  static boxCast(center: Vec3Like, halfExtents: Vec3Like, direction: Vec3Like, orientation: Quaternion = Quaternion.identity, maxDistance = Number.MAX_VALUE, layers?: string[]): ShapeCastHit | null {
    return cast(center, { kind: "box", halfExtents }, orientation, direction, maxDistance, layers);
  }

  /** Sweep a capsule, given its two cap centres, along `direction`. */
  static capsuleCast(point1: Vec3Like, point2: Vec3Like, radius: number, direction: Vec3Like, maxDistance = Number.MAX_VALUE, layers?: string[]): ShapeCastHit | null {
    const c = capsuleFrom(point1, point2, radius);
    return cast(c.center, c.shape, c.rotation, direction, maxDistance, layers);
  }

  /** Every collider overlapping a sphere. */
  static overlapSphere(center: Vec3Like, radius: number, layers?: string[]): Collider[] {
    return physics().queries.overlap({ kind: "sphere", radius }, center, Quaternion.identity, layers);
  }

  /** Every collider overlapping a box (centre, half extents, optional orientation). */
  static overlapBox(center: Vec3Like, halfExtents: Vec3Like, orientation: Quaternion = Quaternion.identity, layers?: string[]): Collider[] {
    return physics().queries.overlap({ kind: "box", halfExtents }, center, orientation, layers);
  }

  /** Every collider overlapping a capsule, given its two cap centres. */
  static overlapCapsule(point1: Vec3Like, point2: Vec3Like, radius: number, layers?: string[]): Collider[] {
    const c = capsuleFrom(point1, point2, radius);
    return physics().queries.overlap(c.shape, c.center, c.rotation, layers);
  }

  /** True if any collider overlaps the sphere. */
  static checkSphere(center: Vec3Like, radius: number, layers?: string[]): boolean {
    return Physics.overlapSphere(center, radius, layers).length > 0;
  }
}
