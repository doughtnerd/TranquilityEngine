/**
 * Colliders for ShapeCollider2D (ADR 0105, 0136, 0423), as neutral descriptions for the 2D backend (ADR 0137).
 * Internal, loaded with the shared core. The shapes come from the 2D shape source on the collider's node
 * (a Tilemap, say; ADR 0136); this module knows nothing of what offers them.
 *
 * A shape collider becomes:
 * - one compound collider holding every solid rectangle and polygon part, with internal edges fixed so
 *   bodies sliding across the seams between parts don't catch;
 * - in "outline" mode, one oriented polyline collider per solid region outline (solid on the left);
 * - one collider per one-way run or polygon, which the backend lets bodies through from below
 *   (capability `oneWayPlatforms`; without it they're solid). With the collider's `oneWay` on, every shape is
 *   one-way: each rectangle, polygon part and outline its own one-way collider (ADR 0423).
 * Everything is rebuilt when the source's signature, the collider's settings or the node's scale change.
 * Poses and scales are the nodes' 2D frames (`scene/frame2d.ts`, ADR 0301): a mirrored tilemap is mirrored.
 */
import type { World } from "../../../../engine/core/World";
import { frame2DOf } from "../../../../engine/scene/frame2d";
import type { BackendCollider, Dim2, PhysicsWorld2DBackend, Point2, ShapeDesc2D, Vec2 } from "../backend";
import type { RigidBody2D } from "../RigidBody2D";
import type { ShapeCollider2D } from "../ShapeCollider2D";
import { oneWayOf, oneWayUp, type OneWay2D } from "./oneWay2d";

/** @internal What the 2D core lends the shape colliders. */
export interface ShapeCollidersHost {
  readonly backend: PhysicsWorld2DBackend;
  readonly world: World;
  /** Whether the backend has one-way platforms. */
  readonly oneWay: boolean;
  groupsFor(layer: string): number;
  register(id: number, c: ShapeCollider2D): void;
  unregister(id: number): void;
  warnOnce(key: string, message: string): void;
}

export class ShapeColliders2D {
  constructor(private readonly host: ShapeCollidersHost) {}

  push(c: ShapeCollider2D): void {
    const source = c.source;
    const active = c.isActiveAndEnabled && !!source && source.isActiveAndEnabled;
    const body = active ? c.attachedRigidbody : null;
    const ws = frame2DOf(c.node).scale;
    const signature = [c.mode, c.oneWay, c.isTrigger, c.layer, c.material?.friction, c.material?.bounciness, c.center.x, c.center.y, ws[0].toFixed(4), ws[1].toFixed(4), source?.collisionSignature() ?? ""].join("|");
    let st = c._shapeState;
    if (st && (st.body !== body || st.signature !== signature || (body && !body._state) || !active)) {
      this.release(c);
      st = null;
    }
    if (!st) {
      if (!active || !source) return;
      if (body && !body._state) return; // made later in this push pass
      st = c._shapeState = { colliders: [], signature, syncedVersion: this.host.world.tVersion[c.node.entity], body, active: true };
      this.build(c, st);
      return;
    }
    if (body) return;
    const version = this.host.world.tVersion[c.node.entity];
    if (version !== st.syncedVersion) {
      // Moved without a body: rebuild, since one-way tops and the shapes' pose depend on it.
      this.release(c);
      this.push(c);
    }
  }

  private build(c: ShapeCollider2D, st: NonNullable<ShapeCollider2D["_shapeState"]>): void {
    const shapes = c.source?.collisionShapes(c.mode);
    if (!shapes) return; // its signature changes once it can say
    const frame = frame2DOf(c.node);
    const ws = frame.scale;
    const sx = shapes.unit.x * ws[0], sy = shapes.unit.y * ws[1];
    const ox = c.center.x * ws[0], oy = c.center.y * ws[1];

    // Node pose (and the body's, when attached).
    const p = { x: frame.position[0], y: frame.position[1] };
    const angle = frame.angle;
    const rb = st.body;
    let tx = p.x, ty = p.y, ta = angle;
    if (rb) {
      const bf = frame2DOf(rb.node);
      const bp = { x: bf.position[0], y: bf.position[1] }, ba = bf.angle;
      const dx = p.x - bp.x, dy = p.y - bp.y, bc = Math.cos(-ba), bs = Math.sin(-ba);
      tx = dx * bc - dy * bs;
      ty = dx * bs + dy * bc;
      ta = angle - ba;
    }
    const local = (x: number, y: number): Vec2 => ({ x: x * sx + ox, y: y * sy + oy });
    const points = (pts: readonly (readonly [number, number])[]): Point2[] => pts.map(([x, y]) => {
      const l = local(x, y);
      return [l.x, l.y] as const;
    });
    // Flipping the scale mirrors the winding, which oriented polylines care about.
    const mirrored = frame.mirrored;

    const allOneWay = c.oneWay && !c.isTrigger;
    if (!this.host.oneWay && (allOneWay || shapes.oneWay.length || shapes.oneWayPolygons.length)) {
      this.host.warnOnce("oneway", "this physics backend has no one-way platforms; one-way colliders are solid.");
    }
    // One-way shapes let bodies through along the node's +Y in the world (flipped with a negative scale); their tops
    // are measured in the world, where the colliders are when built.
    const up = oneWayUp(frame);
    const worldPose = { position: p, rotation: angle };
    const make = (shape: ShapeDesc2D, oneWay: boolean) => {
      const desc: OneWay2D | null = oneWay && this.host.oneWay ? oneWayOf(shape, worldPose, up) : null;
      const collider: BackendCollider<Dim2> = this.host.backend.createCollider({
        shape,
        pose: { position: { x: tx, y: ty }, rotation: ta },
        parent: rb?._state?.body ?? null,
        sensor: c.isTrigger,
        friction: c.material?.friction ?? 0.5,
        restitution: c.material?.bounciness ?? 0,
        groups: this.host.groupsFor(c.layer),
        oneWay: desc,
      });
      this.host.register(collider.id, c);
      st.colliders.push(collider);
    };
    type Rect = { x: number; y: number; w: number; h: number };
    const boxPart = (r: Rect) => ({ shape: { kind: "box", halfExtents: { x: Math.abs((r.w * sx) / 2), y: Math.abs((r.h * sy) / 2) } } as ShapeDesc2D, offset: local(r.x + r.w / 2, r.y + r.h / 2) });
    const box = (r: Rect): ShapeDesc2D => ({ kind: "compound", parts: [boxPart(r)] });
    const outline = (loop: readonly (readonly [number, number])[]): ShapeDesc2D => {
      const pts = mirrored ? [...loop].reverse() : loop;
      return { kind: "polyline", points: points([...pts, pts[0]]), oriented: true };
    };

    if (allOneWay) {
      // Every shape one-way (ADR 0423): each its own collider, judged by its own top.
      for (const b of shapes.boxes) make(box(b), true);
      for (const poly of shapes.polygons) make({ kind: "convexHull", points: points(poly) }, true);
      for (const loop of shapes.loops) make(outline(loop), true);
    } else {
      // Solid parts: one compound.
      const parts: { shape: ShapeDesc2D; offset: Vec2 }[] = [];
      for (const b of shapes.boxes) parts.push(boxPart(b));
      for (const poly of shapes.polygons) parts.push({ shape: { kind: "convexHull", points: points(poly) }, offset: { x: 0, y: 0 } });
      if (parts.length) make({ kind: "compound", parts, fixInternalEdges: true }, false);
      for (const loop of shapes.loops) make(outline(loop), false);
    }

    // One-way runs and polygons: each its own collider.
    for (const r of shapes.oneWay) make(box(r), true);
    for (const poly of shapes.oneWayPolygons) make({ kind: "convexHull", points: points(poly) }, true);
  }

  release(c: ShapeCollider2D): void {
    const st = c._shapeState;
    if (!st) return;
    for (const col of st.colliders) {
      this.host.unregister(col.id);
      this.host.backend.removeCollider(col);
    }
    c._shapeState = null;
  }

  /** Release every shape collider attached to `rb` (the body is going away). */
  releaseFor(rb: RigidBody2D, all: Iterable<ShapeCollider2D>): void {
    for (const c of all) if (c._shapeState?.body === rb) this.release(c);
  }
}
