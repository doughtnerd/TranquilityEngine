/**
 * Rapier colliders for TilemapCollider2D (ADR 0105). Internal, loaded with Physics2DWorld.
 *
 * A tilemap collider becomes:
 * - one compound collider holding every solid rectangle and polygon part, with
 *   `CompoundFlags.FIX_INTERNAL_EDGES` so bodies sliding across the seams between parts don't catch;
 * - in "outline" mode, one oriented polyline collider per solid region outline (solid on the left);
 * - one collider per one-way run or polygon, with the contact-pair hook on, so `filterOneWay`
 *   can let bodies through from below.
 * Everything is rebuilt when the tilemap's cells, the collider's settings or the node's scale change.
 */
import RAPIER from "@dimforge/rapier2d-compat";
import { DEG2RAD } from "../../../engine/core/math";
import type { World } from "../../../engine/core/World";
import { buildTileShapes } from "../../../engine/tilemap/collision";
import type { TilemapCollider2D } from "./TilemapCollider2D";
import type { RigidBody2D } from "./RigidBody2D";

/** @internal What Physics2DWorld lends the tilemap colliders. */
export interface TilemapPhysicsHost {
  readonly rapier: RAPIER.World;
  readonly world: World;
  groupsFor(layer: string): number;
  register(handle: number, c: TilemapCollider2D): void;
  unregister(handle: number): void;
}

interface OneWay {
  /** The platform's up direction in world space and its top along it when built. */
  upX: number;
  upY: number;
  top: number;
  /** The collider's own position along up when built (a platform on a moving body moves its top with it). */
  base: number;
}

export class TilemapPhysics2D {
  /** One-way colliders by handle. */
  private readonly oneWay = new Map<number, OneWay>();
  private dt = 1 / 60;

  constructor(private readonly host: TilemapPhysicsHost) {}

  get hasOneWay(): boolean {
    return this.oneWay.size > 0;
  }

  push(c: TilemapCollider2D): void {
    const map = c.tilemap;
    const active = c.isActiveAndEnabled && !!map && map.isActiveAndEnabled;
    const body = active ? c.attachedRigidbody : null;
    const t = c.node.transform;
    const ws = t ? t.worldScale : { x: 1, y: 1 };
    const layers = map?._layers();
    const signature = [c.mode, c.isTrigger, c.layer, c.material?.friction, c.material?.bounciness, c.center.x, c.center.y, ws.x.toFixed(4), ws.y.toFixed(4), map?.cellSize.x, map?.cellSize.y, map?.tileset, map?.tilesetAsset ? "ts" : "", layers?.map((l) => `${l.version}:${l.meta.collision}`).join(",")].join("|");
    let st = c._tileState;
    if (st && (st.body !== body || st.signature !== signature || (body && !body._state) || !active)) {
      this.release(c);
      st = null;
    }
    if (!st) {
      if (!active || !map) return;
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
    const map = c.tilemap!;
    const ts = map.tilesetAsset;
    if (!ts) return;
    const t = c.node.transform;
    const ws = t ? t.worldScale : { x: 1, y: 1 };
    const sx = map.cellSize.x * ws.x, sy = map.cellSize.y * ws.y;
    const ox = c.center.x * ws.x, oy = c.center.y * ws.y;
    const cells: { x: number; y: number; value: number }[] = [];
    map._layers().forEach((l, i) => {
      if (!l.meta.collision) return;
      for (const cell of map.tiles(i)) cells.push(cell);
    });
    const shapes = buildTileShapes(cells, (id) => ts.tile(id)?.collision, c.mode);

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
    const local = (x: number, y: number) => ({ x: x * sx + ox, y: y * sy + oy });
    const flat = (pts: readonly (readonly [number, number])[]) => {
      const out = new Float32Array(pts.length * 2);
      pts.forEach(([x, y], i) => {
        const l = local(x, y);
        out[i * 2] = l.x;
        out[i * 2 + 1] = l.y;
      });
      return out;
    };
    // Flipping the scale mirrors the winding, which oriented polylines care about.
    const mirrored = ws.x * ws.y < 0;

    const make = (desc: RAPIER.ColliderDesc, oneWay: OneWay | null) => {
      desc
        .setTranslation(tx, ty)
        .setRotation(ta)
        .setSensor(c.isTrigger)
        .setFriction(c.material?.friction ?? 0.5)
        .setRestitution(c.material?.bounciness ?? 0)
        .setCollisionGroups(this.host.groupsFor(c.layer))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED);
      if (rb) desc.setDensity(0);
      if (oneWay) desc.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS);
      const collider = this.host.rapier.createCollider(desc, rb?._state?.body);
      this.host.register(collider.handle, c);
      st.colliders.push(collider);
      if (oneWay) this.oneWay.set(collider.handle, oneWay);
    };

    // Solid parts: one compound.
    const parts: RAPIER.Shape[] = [], positions: RAPIER.Vector[] = [], rotations: number[] = [];
    for (const b of shapes.boxes) {
      const hw = Math.abs((b.w * sx) / 2), hh = Math.abs((b.h * sy) / 2);
      parts.push(new RAPIER.Cuboid(hw, hh));
      positions.push(local(b.x + b.w / 2, b.y + b.h / 2));
      rotations.push(0);
    }
    for (const poly of shapes.polygons) {
      parts.push(new RAPIER.ConvexPolygon(flat(poly), false));
      positions.push({ x: 0, y: 0 });
      rotations.push(0);
    }
    if (parts.length) {
      make(RAPIER.ColliderDesc.compound(parts, positions, rotations, RAPIER.CompoundFlags.FIX_INTERNAL_EDGES), null);
    }
    for (const loop of shapes.loops) {
      const pts = mirrored ? [...loop].reverse() : loop;
      const closed = [...pts, pts[0]];
      make(RAPIER.ColliderDesc.polyline(flat(closed), null, RAPIER.PolylineFlags.ORIENTED), null);
    }

    // One-way parts: each its own collider. The up direction is the node's +Y (flipped with a negative scale).
    const upSign = ws.y < 0 ? -1 : 1;
    const upX = -sin * upSign, upY = cos * upSign;
    const base = p.x * upX + p.y * upY;
    const topOf = (lx: number, ly: number) => {
      // World point of a local point, then its height along up.
      const wx = p.x + lx * cos - ly * sin, wy = p.y + lx * sin + ly * cos;
      return wx * upX + wy * upY;
    };
    for (const r of shapes.oneWay) {
      const hw = Math.abs((r.w * sx) / 2), hh = Math.abs((r.h * sy) / 2);
      const centre = local(r.x + r.w / 2, r.y + r.h / 2);
      const top = local(r.x + r.w / 2, ws.y < 0 ? r.y : r.y + r.h);
      make(RAPIER.ColliderDesc.compound([new RAPIER.Cuboid(hw, hh)], [centre], [0]), { upX, upY, top: topOf(top.x, top.y), base });
    }
    for (const poly of shapes.oneWayPolygons) {
      let top = -Infinity;
      for (const [x, y] of poly) {
        const l = local(x, y);
        top = Math.max(top, topOf(l.x, l.y));
      }
      make(RAPIER.ColliderDesc.convexHull(flat(poly)) ?? RAPIER.ColliderDesc.ball(1e-4), { upX, upY, top, base });
    }
  }

  /** Bodies' colliders as they were before the step: Rapier's world can't be read from inside a hook. */
  private readonly snapshot = new Map<number, { x: number; y: number; hx: number; hy: number; vx: number; vy: number }>();

  /** Called before each step: note the timestep and, with one-way platforms about, every moving collider's pose and velocity. */
  beforeStep(dt: number): void {
    this.dt = dt;
    this.snapshot.clear();
    if (!this.oneWay.size) return;
    this.host.rapier.forEachCollider((col) => {
      const body = col.parent();
      if (!body || body.isFixed()) return;
      const p = col.translation();
      const he = col.halfExtents();
      const r = he ? 0 : col.shapeType() === RAPIER.ShapeType.Ball ? col.radius() : 0;
      const v = body.linvel();
      this.snapshot.set(col.handle, { x: p.x, y: p.y, hx: he ? he.x : r, hy: he ? he.y : r, vx: v.x, vy: v.y });
    });
  }

  /**
   * The contact-pair hook: a one-way platform collides only with bodies above its top that aren't
   * moving up through it. Only one-way colliders turn the hook on, so other pairs never reach here.
   */
  filter(c1: number, c2: number): RAPIER.SolverFlags | null {
    let platformHandle = c1, other = c2;
    let platform = this.oneWay.get(c1);
    if (!platform) {
      platform = this.oneWay.get(c2);
      platformHandle = c2;
      other = c1;
    }
    if (!platform || this.oneWay.has(other)) return RAPIER.SolverFlags.COMPUTE_IMPULSE;
    const o = this.snapshot.get(other);
    if (!o) return RAPIER.SolverFlags.COMPUTE_IMPULSE; // a static collider
    const { upX, upY } = platform;
    const bottom = o.x * upX + o.y * upY - (Math.abs(o.hx * upX) + Math.abs(o.hy * upY));
    let rel = o.vx * upX + o.vy * upY;
    const pv = this.snapshot.get(platformHandle); // a platform on a moving body
    let top = platform.top;
    if (pv) {
      rel -= pv.vx * upX + pv.vy * upY;
      top += (pv.x * upX + pv.y * upY) - platform.base;
    }
    const tolerance = 0.02 + Math.abs(rel) * this.dt;
    return rel > 0.01 || bottom < top - tolerance ? RAPIER.SolverFlags.EMPTY : RAPIER.SolverFlags.COMPUTE_IMPULSE;
  }

  release(c: TilemapCollider2D): void {
    const st = c._tileState;
    if (!st) return;
    for (const col of st.colliders) {
      this.host.unregister(col.handle);
      this.oneWay.delete(col.handle);
      const live = this.host.rapier.getCollider(col.handle);
      if (live) this.host.rapier.removeCollider(live, true);
    }
    c._tileState = null;
  }

  /** Release every tilemap collider attached to `rb` (the body is going away). */
  releaseFor(rb: RigidBody2D, all: Iterable<TilemapCollider2D>): void {
    for (const c of all) if (c._tileState?.body === rb) this.release(c);
  }
}
