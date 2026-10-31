import { Vector2, type Vec2Like } from "../core/math";
import { World } from "../core/World";
import type { Collider2D } from "./Collider2D";

export interface RaycastHit2D {
  collider: Collider2D;
  point: Vector2;
  normal: Vector2;
  distance: number;
}

function physics() {
  const p = World.require().physics2D;
  if (!p) throw new Error('2D physics is not running. Load a scene with "settings": { "physics": "2d" }.');
  return p;
}

/** 2D physics queries and settings for the active world (ADR 0005). */
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
}
