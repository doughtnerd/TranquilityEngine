import { physics2DOf } from "./physics2dSystems";
import { Vector2, type Vec2Like } from "../../../engine/core/math";
import { World } from "../../../engine/core/World";
import type { Collider2D } from "./Collider2D";

export interface RaycastHit2D {
  collider: Collider2D;
  point: Vector2;
  normal: Vector2;
  distance: number;
}

/** A 2D shape cast hit (ADR 0010: engine types only). `distance` is how far the shape travelled. */
export interface ShapeCastHit2D {
  collider: Collider2D;
  point: Vector2;
  normal: Vector2;
  distance: number;
}

type CastShape2D = { kind: "circle"; radius: number } | { kind: "box"; halfExtents: Vec2Like } | { kind: "capsule"; radius: number; halfHeight: number };

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Vertical capsule from its full size (Unity CapsuleDirection2D.Vertical). */
function capsuleOf(size: Vec2Like): CastShape2D {
  const radius = size.x / 2;
  return { kind: "capsule", radius, halfHeight: Math.max(0, size.y / 2 - radius) };
}

function cast(origin: Vec2Like, shape: CastShape2D, angle: number, direction: Vec2Like, maxDistance: number, layers?: string[]): ShapeCastHit2D | null {
  const hit = physics().queries.castShape(shape, origin, toRad(angle), direction, maxDistance, layers);
  if (!hit) return null;
  return { collider: hit.collider, point: Vector2.from(hit.point), normal: Vector2.from(hit.normal), distance: hit.distance };
}

function physics() {
  const p = physics2DOf(World.require());
  if (!p) throw new Error('2D physics is not running. Load a scene with "settings": { "physics": "2d" }, or one with 2D bodies or colliders.');
  return p;
}

/**
 * 2D physics queries and settings for the current World (ADR 0005, 0032). Each World has its own
 * physics world; queries never see another World's colliders.
 */
export class Physics2D {
  static get gravity(): Vector2 {
    const g = physics().gravity;
    return new Vector2(g.x, g.y);
  }
  static set gravity(g: Vec2Like) {
    physics().gravity = { x: g.x, y: g.y };
  }

  /** Cast a ray; optionally restrict hits to the named layers. */
  static raycast(origin: Vec2Like, direction: Vec2Like, maxDistance = Number.MAX_VALUE, layers?: string[]): RaycastHit2D | null {
    const hit = physics().raycast(origin, direction, maxDistance, layers);
    if (!hit) return null;
    return { collider: hit.collider, point: Vector2.from(hit.point), normal: Vector2.from(hit.normal), distance: hit.distance };
  }

  /** Sweep a circle along `direction`; returns the first collider hit. */
  static circleCast(origin: Vec2Like, radius: number, direction: Vec2Like, maxDistance = Number.MAX_VALUE, layers?: string[]): ShapeCastHit2D | null {
    return cast(origin, { kind: "circle", radius }, 0, direction, maxDistance, layers);
  }

  /** Sweep a box (full `size`, rotated by `angle` degrees) along `direction`. */
  static boxCast(origin: Vec2Like, size: Vec2Like, angle: number, direction: Vec2Like, maxDistance = Number.MAX_VALUE, layers?: string[]): ShapeCastHit2D | null {
    return cast(origin, { kind: "box", halfExtents: { x: size.x / 2, y: size.y / 2 } }, angle, direction, maxDistance, layers);
  }

  /** Sweep a vertical capsule (full `size`, rotated by `angle` degrees) along `direction`. */
  static capsuleCast(origin: Vec2Like, size: Vec2Like, angle: number, direction: Vec2Like, maxDistance = Number.MAX_VALUE, layers?: string[]): ShapeCastHit2D | null {
    return cast(origin, capsuleOf(size), angle, direction, maxDistance, layers);
  }

  /** Every collider overlapping a circle. */
  static overlapCircle(point: Vec2Like, radius: number, layers?: string[]): Collider2D[] {
    return physics().queries.overlap({ kind: "circle", radius }, point, 0, layers);
  }

  /** Every collider overlapping a box (full `size`, rotated by `angle` degrees). */
  static overlapBox(point: Vec2Like, size: Vec2Like, angle = 0, layers?: string[]): Collider2D[] {
    return physics().queries.overlap({ kind: "box", halfExtents: { x: size.x / 2, y: size.y / 2 } }, point, toRad(angle), layers);
  }

  /** Every collider overlapping a vertical capsule (full `size`, rotated by `angle` degrees). */
  static overlapCapsule(point: Vec2Like, size: Vec2Like, angle = 0, layers?: string[]): Collider2D[] {
    return physics().queries.overlap(capsuleOf(size), point, toRad(angle), layers);
  }

  /** Every collider containing the point. */
  static overlapPoint(point: Vec2Like, layers?: string[]): Collider2D[] {
    return physics().queries.overlapPoint(point, layers);
  }
}
