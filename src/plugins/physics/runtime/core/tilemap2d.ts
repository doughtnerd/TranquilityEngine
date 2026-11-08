/**
 * Colliders for TilemapCollider2D (ADR 0105, 0136), as neutral descriptions for the 2D backend (ADR 0137).
 * Internal, loaded with the shared core. The shapes come from the 2D shape source on the collider's node
 * (a Tilemap, say; ADR 0136); this module knows nothing of what offers them.
 *
 * A shape collider becomes:
 * - one compound collider holding every solid rectangle and polygon part, with internal edges fixed so
 *   bodies sliding across the seams between parts don't catch;
 * - in "outline" mode, one oriented polyline collider per solid region outline (solid on the left);
 * - one collider per one-way run or polygon, which the backend lets bodies through from below
 *   (capability `oneWayPlatforms`; without it they're solid).
 * Everything is rebuilt when the source's signature, the collider's settings or the node's scale change.
 */
import { DEG2RAD } from "../../../../engine/core/math";
import type { World } from "../../../../engine/core/World";
import type { BackendCollider, Dim2, PhysicsWorld2DBackend, Point2, ShapeDesc2D, Vec2 } from "../backend";
import type { RigidBody2D } from "../RigidBody2D";
import type { TilemapCollider2D } from "../TilemapCollider2D";

/** @internal What the 2D core lends the tilemap colliders. */
export interface TilemapCollidersHost {
  readonly backend: PhysicsWorld2DBackend;
  readonly world: World;
  /** Whether the backend has one-way platforms. */
  readonly oneWay: boolean;
  groupsFor(layer: string): number;
  register(id: number, c: TilemapCollider2D): void;
  unregister(id: number): void;
  warnOnce(key: string, message: string): void;
}

export class TilemapColliders2D {
  constructor(private readonly host: TilemapCollidersHost) {}

  push(c: TilemapCollider2D): void {
    const source = c.source;
    const active = c.isActiveAndEnabled && !!source && source.isActiveAndEnabled;
    const body = active ? c.attachedRigidbody : null;
    const t = c.node.transform;
    const ws = t ? t.worldScale : { x: 1, y: 1 };
    const signature = [c.mode, c.isTrigger, c.layer, c.material?.friction, c.material?.bounciness, c.center.x, c.center.y, ws.x.toFixed(4), ws.y.toFixed(4), source?.collisionSignature() ?? ""].join("|");
    let st = c._tileState;
    if (st && (st.body !== body || st.signature !== signature || (body && !body._state) || !active)) {
      this.release(c);
      st = null;
    }
    if (!st) {
      if (!active || !source) return;
      if (body && !body._state) return; // made later in this push pass
      st = c._tileState = { colliders: [], signature, syncedVersion: this.host.world.tVersion[c.node.entity], body, active: true };
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

  private build(c: TilemapCollider2D, st: NonNullable<TilemapCollider2D["_tileState"]>): void {
    const shapes = c.source?.collisionShapes(c.mode);
    if (!shapes) return; // its signature changes once it can say
    const t = c.node.transform;
    const ws = t ? t.worldScale : { x: 1, y: 1 };
    const sx = shapes.unit.x * ws.x, sy = shapes.unit.y * ws.y;
    const ox = c.center.x * ws.x, oy = c.center.y * ws.y;

    // Node pose (and the body's, when attached).
    const p = t ? t.worldPosition : { x: 0, y: 0 };
    const angle = t ? t.worldRotation2D * DEG2RAD : 0;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const rb = st.body;
    let tx = p.x, ty = p.y, ta = angle;
    if (rb) {
      const bt = rb.node.transform;
      const bp = bt ? bt.worldPosition : { x: 0, y: 0 };
      const ba = bt ? bt.worldRotation2D * DEG2RAD : 0;
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
    const mirrored = ws.x * ws.y < 0;

    if (!this.host.oneWay && (shapes.oneWay.length || shapes.oneWayPolygons.length)) {
      this.host.warnOnce("oneway", "this physics backend has no one-way platforms; one-way tiles are solid.");
    }
    const make = (shape: ShapeDesc2D, oneWay: { up: Vec2; top: number; base: number } | null) => {
      const collider: BackendCollider<Dim2> = this.host.backend.createCollider({
        shape,
        pose: { position: { x: tx, y: ty }, rotation: ta },
        parent: rb?._state?.body ?? null,
        sensor: c.isTrigger,
        friction: c.material?.friction ?? 0.5,
        restitution: c.material?.bounciness ?? 0,
        groups: this.host.groupsFor(c.layer),
        oneWay: this.host.oneWay ? oneWay : null,
      });
      this.host.register(collider.id, c);
      st.colliders.push(collider);
    };

    // Solid parts: one compound.
    const parts: { shape: ShapeDesc2D; offset: Vec2 }[] = [];
    for (const b of shapes.boxes) parts.push({ shape: { kind: "box", halfExtents: { x: Math.abs((b.w * sx) / 2), y: Math.abs((b.h * sy) / 2) } }, offset: local(b.x + b.w / 2, b.y + b.h / 2) });
    for (const poly of shapes.polygons) parts.push({ shape: { kind: "convexHull", points: points(poly) }, offset: { x: 0, y: 0 } });
    if (parts.length) make({ kind: "compound", parts, fixInternalEdges: true }, null);
    for (const loop of shapes.loops) {
      const pts = mirrored ? [...loop].reverse() : loop;
      make({ kind: "polyline", points: points([...pts, pts[0]]), oriented: true }, null);
    }

    // One-way parts: each its own collider. The up direction is the node's +Y (flipped with a negative scale).
    const upSign = ws.y < 0 ? -1 : 1;
    const up = { x: -sin * upSign, y: cos * upSign };
    const base = p.x * up.x + p.y * up.y;
    const topOf = (lx: number, ly: number) => {
      // World point of a local point, then its height along up.
      const wx = p.x + lx * cos - ly * sin, wy = p.y + lx * sin + ly * cos;
      return wx * up.x + wy * up.y;
    };
    for (const r of shapes.oneWay) {
      const centre = local(r.x + r.w / 2, r.y + r.h / 2);
      const top = local(r.x + r.w / 2, ws.y < 0 ? r.y : r.y + r.h);
      make({ kind: "compound", parts: [{ shape: { kind: "box", halfExtents: { x: Math.abs((r.w * sx) / 2), y: Math.abs((r.h * sy) / 2) } }, offset: centre }] }, { up, top: topOf(top.x, top.y), base });
    }
    for (const poly of shapes.oneWayPolygons) {
      let top = -Infinity;
      for (const [x, y] of poly) {
        const l = local(x, y);
        top = Math.max(top, topOf(l.x, l.y));
      }
      make({ kind: "convexHull", points: points(poly) }, { up, top, base });
    }
  }

  release(c: TilemapCollider2D): void {
    const st = c._tileState;
    if (!st) return;
    for (const col of st.colliders) {
      this.host.unregister(col.id);
      this.host.backend.removeCollider(col);
    }
    c._tileState = null;
  }

  /** Release every tilemap collider attached to `rb` (the body is going away). */
  releaseFor(rb: RigidBody2D, all: Iterable<TilemapCollider2D>): void {
    for (const c of all) if (c._tileState?.body === rb) this.release(c);
  }
}
