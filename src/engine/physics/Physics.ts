import { Ray, Vector3, type Vec3Like } from "../core/math";
import { World } from "../core/World";
import type { Collider } from "./Collider";

export interface RaycastHit {
  collider: Collider;
  point: Vector3;
  normal: Vector3;
  distance: number;
}

function physics() {
  const p = World.require().physics3D;
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
}
