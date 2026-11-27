/**
 * How the 2D core describes a one-way collider to the backend (ADR 0105, 0437): `{ up, top, base }`, where `up`
 * is the node's +Y in the world (turned and mirrored with its 2D frame, ADR 0301), `top` the shape's highest extent
 * along `up` and `base` the collider's own position along `up`, both when it is built (a collider on a moving body
 * moves its top with it). Shared by every one-way collider: the shape collider's tiles and runs, and any 2D
 * collider with `oneWay` on. Internal, loaded with the core.
 */
import { frameDirection, type Frame2D } from "../../../../engine/scene/frame2d";
import type { Pose, ShapeDesc2D, Vec2, Dim2 } from "../backend";

/** A one-way collider's description, as `ColliderDesc.oneWay` takes it. */
export interface OneWay2D {
  readonly up: Vec2;
  readonly top: number;
  readonly base: number;
}

/** The node's +Y in the world, unit length: the way a one-way collider on it lets bodies through. */
export function oneWayUp(frame: Frame2D): Vec2 {
  const [ux, uy] = frameDirection(frame, [0, 1]);
  const l = Math.hypot(ux, uy) || 1;
  return { x: ux / l, y: uy / l };
}

/** The one-way description of `shape` placed at `pose` (in the world) and letting bodies through along `up`. */
export function oneWayOf(shape: ShapeDesc2D, pose: Pose<Dim2>, up: Vec2): OneWay2D {
  const { x, y } = pose.position;
  return { up, top: shapeTop(shape, x, y, pose.rotation, up), base: x * up.x + y * up.y };
}

/** The highest extent along `up` of `shape` placed at `(ox, oy)`, turned by `rotation` radians. */
function shapeTop(shape: ShapeDesc2D, ox: number, oy: number, rotation: number, up: Vec2): number {
  const c = Math.cos(rotation), s = Math.sin(rotation);
  const along = (x: number, y: number) => (ox + x * c - y * s) * up.x + (oy + x * s + y * c) * up.y;
  const highest = (points: readonly (readonly [number, number])[]) => points.reduce((m, p) => Math.max(m, along(p[0], p[1])), -Infinity);
  switch (shape.kind) {
    case "box": {
      const { x: hx, y: hy } = shape.halfExtents;
      return highest([[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]);
    }
    case "circle":
      return along(0, 0) + shape.radius;
    case "capsule":
      return highest([[0, -shape.halfHeight], [0, shape.halfHeight]]) + shape.radius;
    case "convexPolygons":
      return Math.max(highest(shape.outline), ...shape.parts.map(highest));
    case "convexHull":
    case "polyline":
      return highest(shape.points);
    case "compound": {
      let top = -Infinity;
      for (const part of shape.parts) {
        const px = ox + part.offset.x * c - part.offset.y * s, py = oy + part.offset.x * s + part.offset.y * c;
        top = Math.max(top, shapeTop(part.shape, px, py, rotation, up));
      }
      return top;
    }
    case "voxels": {
      const { x: w, y: h } = shape.size, cells = shape.cells;
      let top = -Infinity;
      for (let i = 0; i + 1 < cells.length; i += 2) {
        const x = cells[i] * w, y = cells[i + 1] * h;
        top = Math.max(top, highest([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]));
      }
      return top;
    }
  }
}
