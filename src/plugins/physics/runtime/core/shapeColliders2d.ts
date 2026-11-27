/**
 * Colliders for ShapeCollider2D (ADR 0105, 0136, 0437, 0442), as neutral descriptions for the 2D backend (ADR 0137).
 * Internal, loaded with the shared core. The shapes come from the 2D shape source on the collider's node
 * (a Tilemap, say; ADR 0136); this module knows nothing of what offers them.
 *
 * A shape collider becomes:
 * - one compound collider holding every solid rectangle and polygon part, with internal edges fixed so
 *   bodies sliding across the seams between parts don't catch;
 * - in "outline" mode, one oriented polyline collider per solid region outline (solid on the left);
 * - one collider per one-way run or polygon, which the backend lets bodies through from below
 *   (capability `oneWayPlatforms`; without it they're solid). With the collider's `oneWay` on, every shape is
 *   one-way: each rectangle, polygon part and outline its own one-way collider (ADR 0437).
 * Everything is rebuilt when the source's signature, the collider's settings or the node's scale change.
 *
 * Voxels (ADR 0442): in "rectangles" mode, on a backend with `voxelColliders` and a source that offers its whole cells
 * per chunk (`collisionCells`, a square tile map), the whole cells become one voxel collider per chunk and cell group
 * instead, linked with their neighbours so the faces between chunks don't catch. When only the source's content
 * changes, the chunks whose version changed are diffed and edited in place (`setVoxels`), a chunk that empties is
 * removed and a new one added and linked; the other shapes (polygons, one-way) are rebuilt only when they changed.
 * All of a group's chunk colliders share one origin, so cell coordinates are the group's and links need no shift.
 *
 * Poses and scales are the nodes' 2D frames (`scene/frame2d.ts`, ADR 0301): a mirrored tilemap is mirrored (voxel
 * cells by mapping their coordinates, since a voxel's size is positive).
 */
import type { World } from "../../../../engine/core/World";
import type { CollisionCells2D, CollisionShapes2D } from "../../../../engine/physics/shapeSource2D";
import { frame2DOf } from "../../../../engine/scene/frame2d";
import type { BackendCollider, Dim2, PhysicsWorld2DBackend, Point2, Pose, ShapeDesc2D, Vec2, VoxelChange2D, VoxelLink2D } from "../backend";
import type { RigidBody2D } from "../RigidBody2D";
import type { ShapeCollider2D } from "../ShapeCollider2D";
import { oneWayOf, oneWayUp, type OneWay2D } from "./oneWay2d";
import type { ShapeColliderState, ShapeVoxelState, VoxelChunkState } from "./state";

/** @internal What the 2D core lends the shape colliders. */
export interface ShapeCollidersHost {
  readonly backend: PhysicsWorld2DBackend;
  readonly world: World;
  /** Whether the backend has one-way platforms. */
  readonly oneWay: boolean;
  /** Whether the backend has voxel colliders (ADR 0442). */
  readonly voxels: boolean;
  groupsFor(layer: string): number;
  register(id: number, c: ShapeCollider2D): void;
  unregister(id: number): void;
  warnOnce(key: string, message: string): void;
}

type State = ShapeColliderState<Dim2, RigidBody2D>;
type Rect = { x: number; y: number; w: number; h: number };

/** Where a shape collider's shapes go: shape units to the collider's frame, and how to make a collider there. */
interface Placement {
  /** One shape unit along x and y in the collider's frame (negative when mirrored). */
  sx: number;
  sy: number;
  local(x: number, y: number): Vec2;
  points(pts: readonly (readonly [number, number])[]): Point2[];
  mirrored: boolean;
  /** The pose of a collider whose frame is moved by `offset` (in the node's scaled local units). */
  poseAt(offset: Vec2): Pose<Dim2>;
  /** Make a collider of `shape` (one-way or not), at the node's pose or `pose`, into `into`. */
  make(shape: ShapeDesc2D, oneWay: boolean, into: BackendCollider<Dim2>[], pose?: Pose<Dim2>): BackendCollider<Dim2>;
}

const NO_SHIFT: Vec2 = { x: 0, y: 0 };

export class ShapeColliders2D {
  constructor(private readonly host: ShapeCollidersHost) {}

  push(c: ShapeCollider2D): void {
    const source = c.source;
    const active = c.isActiveAndEnabled && !!source && source.isActiveAndEnabled;
    const body = active ? c.attachedRigidbody : null;
    const ws = frame2DOf(c.node).scale;
    const settings = [c.mode, c.oneWay, c.isTrigger, c.layer, c.material?.friction, c.material?.bounciness, c.center.x, c.center.y, ws[0].toFixed(4), ws[1].toFixed(4)].join("|");
    const signature = `${settings}|${source?.collisionSignature() ?? ""}`;
    let st = c._shapeState;
    // Only the source's content changed under voxel colliders: edit them in place (ADR 0442).
    if (st?.voxels && active && st.body === body && (!body || body._state) && st.voxels.settings === settings && st.signature !== signature) {
      if (this.updateVoxels(c, st, st.voxels)) st.signature = signature;
      else this.release(c);
      st = c._shapeState;
    }
    if (st && (st.body !== body || st.signature !== signature || (body && !body._state) || !active)) {
      this.release(c);
      st = null;
    }
    if (!st) {
      if (!active || !source) return;
      if (body && !body._state) return; // made later in this push pass
      st = c._shapeState = { colliders: [], signature, syncedVersion: this.host.world.tVersion[c.node.entity], body, active: true, voxels: null };
      this.build(c, st, settings);
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

  /** How shapes in units of `unit` land in the collider's frame, for `c` now. */
  private placement(c: ShapeCollider2D, st: State, unit: { x: number; y: number }): Placement {
    const frame = frame2DOf(c.node);
    const ws = frame.scale;
    const sx = unit.x * ws[0], sy = unit.y * ws[1];
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
    const nodePose: Pose<Dim2> = { position: { x: tx, y: ty }, rotation: ta };
    const ca = Math.cos(ta), sa = Math.sin(ta);
    const poseAt = (o: Vec2): Pose<Dim2> => ({ position: { x: tx + o.x * ca - o.y * sa, y: ty + o.x * sa + o.y * ca }, rotation: ta });
    // One-way shapes let bodies through along the node's +Y in the world (flipped with a negative scale); their tops
    // are measured in the world, where the colliders are when built.
    const up = oneWayUp(frame);
    const worldPose = { position: p, rotation: angle };
    const make = (shape: ShapeDesc2D, oneWay: boolean, into: BackendCollider<Dim2>[], pose = nodePose) => {
      const desc: OneWay2D | null = oneWay && this.host.oneWay ? oneWayOf(shape, worldPose, up) : null;
      const collider: BackendCollider<Dim2> = this.host.backend.createCollider({
        shape,
        pose,
        parent: rb?._state?.body ?? null,
        sensor: c.isTrigger,
        friction: c.material?.friction ?? 0.5,
        restitution: c.material?.bounciness ?? 0,
        groups: this.host.groupsFor(c.layer),
        oneWay: desc,
      });
      this.host.register(collider.id, c);
      into.push(collider);
      return collider;
    };
    // Flipping the scale mirrors the winding, which oriented polylines care about.
    return { sx, sy, local, points, mirrored: frame.mirrored, poseAt, make };
  }

  private build(c: ShapeCollider2D, st: State, settings: string): void {
    const source = c.source;
    if (!source) return;
    const allOneWay = c.oneWay && !c.isTrigger;
    if (this.host.voxels && c.mode === "rectangles" && !allOneWay && source.collisionCells) {
      const cells = source.collisionCells();
      if (cells) {
        const rest = source.collisionShapes("rectangles", { withoutCells: true });
        if (!rest) return; // its signature changes once it can say
        const vs: ShapeVoxelState<Dim2> = { settings, lattice: latticeOf(cells), groups: new Map(), rest, restColliders: [] };
        st.voxels = vs;
        const place = this.placement(c, st, cells.unit);
        for (const g of cells.groups) {
          const chunks = new Map<string, VoxelChunkState<Dim2>>();
          vs.groups.set(g.key, { offset: { x: g.offset.x, y: g.offset.y }, chunks });
          for (const ch of g.chunks) this.addChunk(place, st, chunks, g.offset, cells.chunkSize, ch.cx, ch.cy, ch.version, ch.solid);
        }
        this.buildShapes(c, this.placement(c, st, rest.unit), rest, false, st.colliders, vs.restColliders);
        return;
      }
    }
    const shapes = source.collisionShapes(c.mode);
    if (!shapes) return; // its signature changes once it can say
    this.buildShapes(c, this.placement(c, st, shapes.unit), shapes, allOneWay, st.colliders);
  }

  /** Colliders for `shapes`, into each of `into`. */
  private buildShapes(c: ShapeCollider2D, place: Placement, shapes: CollisionShapes2D, allOneWay: boolean, ...into: BackendCollider<Dim2>[][]): void {
    const { sx, sy, local, points, mirrored } = place;
    const make = (shape: ShapeDesc2D, oneWay: boolean) => {
      const col = place.make(shape, oneWay, into[0]);
      for (let i = 1; i < into.length; i++) into[i].push(col);
    };
    if (!this.host.oneWay && (allOneWay || shapes.oneWay.length || shapes.oneWayPolygons.length)) {
      this.host.warnOnce("oneway", "this physics backend has no one-way platforms; one-way colliders are solid.");
    }
    const boxPart = (r: Rect) => ({ shape: { kind: "box", halfExtents: { x: Math.abs((r.w * sx) / 2), y: Math.abs((r.h * sy) / 2) } } as ShapeDesc2D, offset: local(r.x + r.w / 2, r.y + r.h / 2) });
    const box = (r: Rect): ShapeDesc2D => ({ kind: "compound", parts: [boxPart(r)] });
    const outline = (loop: readonly (readonly [number, number])[]): ShapeDesc2D => {
      const pts = mirrored ? [...loop].reverse() : loop;
      return { kind: "polyline", points: points([...pts, pts[0]]), oriented: true };
    };

    if (allOneWay) {
      // Every shape one-way (ADR 0437): each its own collider, judged by its own top.
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

  /** A chunk's voxel collider, linked with the group's chunk colliders around it. */
  private addChunk(place: Placement, st: State, chunks: Map<string, VoxelChunkState<Dim2>>, offset: Vec2, size: number, cx: number, cy: number, version: string, solid: Uint8Array): void {
    const map = cellMapping(place, size, cx, cy);
    const cells: number[] = [];
    for (let i = 0; i < solid.length; i++) if (solid[i]) cells.push(map.x(i), map.y(i));
    if (!cells.length) return;
    const shape: ShapeDesc2D = { kind: "voxels", size: { x: Math.abs(place.sx), y: Math.abs(place.sy) }, cells: Int32Array.from(cells) };
    const collider = place.make(shape, false, st.colliders, place.poseAt(place.local(offset.x, offset.y)));
    for (const n of neighbours(chunks, cx, cy)) this.host.backend.linkVoxels!(collider, n.collider, NO_SHIFT);
    chunks.set(`${cx},${cy}`, { cx, cy, version, solid: solid.slice(), collider });
  }

  /** Empty a chunk's collider (so its neighbours' faces toward it collide again) and remove it. */
  private removeChunk(st: State, chunks: Map<string, VoxelChunkState<Dim2>>, key: string, place: Placement, size: number): void {
    const ch = chunks.get(key)!;
    chunks.delete(key);
    const map = cellMapping(place, size, ch.cx, ch.cy);
    const changes: VoxelChange2D[] = [];
    for (let i = 0; i < ch.solid.length; i++) if (ch.solid[i]) changes.push({ x: map.x(i), y: map.y(i), filled: false });
    const links = links2D(neighbours(chunks, ch.cx, ch.cy));
    if (links.length && changes.length) this.host.backend.setVoxels!(ch.collider, changes, links);
    this.removeCollider(st, ch.collider);
  }

  private removeCollider(st: State, col: BackendCollider<Dim2>): void {
    const i = st.colliders.indexOf(col);
    if (i >= 0) st.colliders.splice(i, 1);
    this.host.unregister(col.id);
    this.host.backend.removeCollider(col);
  }

  /**
   * The source's content changed under voxel colliders (ADR 0442): edit the chunks whose version changed, add and
   * remove chunks, and rebuild the other shapes if they changed. False when it can't be done in place (the cells' unit
   * or a group's offset changed, the source offers no cells now): the caller rebuilds.
   */
  private updateVoxels(c: ShapeCollider2D, st: State, vs: ShapeVoxelState<Dim2>): boolean {
    const source = c.source;
    const cells = source?.collisionCells?.();
    if (!source || !cells || latticeOf(cells) !== vs.lattice) return false;
    for (const g of cells.groups) {
      const old = vs.groups.get(g.key);
      if (old && (old.offset.x !== g.offset.x || old.offset.y !== g.offset.y)) return false;
    }
    const rest = source.collisionShapes("rectangles", { withoutCells: true });
    if (!rest) return false;
    const size = cells.chunkSize;
    const place = this.placement(c, st, cells.unit);
    const seenGroups = new Set<string>();
    for (const g of cells.groups) {
      seenGroups.add(g.key);
      let group = vs.groups.get(g.key);
      if (!group) vs.groups.set(g.key, (group = { offset: { x: g.offset.x, y: g.offset.y }, chunks: new Map() }));
      const chunks = group.chunks;
      const seen = new Set<string>();
      for (const ch of g.chunks) {
        const key = `${ch.cx},${ch.cy}`;
        seen.add(key);
        const prev = chunks.get(key);
        if (!prev) this.addChunk(place, st, chunks, g.offset, size, ch.cx, ch.cy, ch.version, ch.solid);
        else if (prev.version !== ch.version) this.editChunk(prev, chunks, place, size, ch.version, ch.solid);
      }
      for (const key of [...chunks.keys()]) if (!seen.has(key)) this.removeChunk(st, chunks, key, place, size);
    }
    for (const [key, group] of [...vs.groups]) {
      if (seenGroups.has(key)) continue;
      for (const k of [...group.chunks.keys()]) this.removeChunk(st, group.chunks, k, place, size);
      vs.groups.delete(key);
    }
    if (!sameShapes(rest, vs.rest)) {
      for (const col of vs.restColliders) this.removeCollider(st, col);
      vs.restColliders = [];
      vs.rest = rest;
      this.buildShapes(c, this.placement(c, st, rest.unit), rest, false, st.colliders, vs.restColliders);
    }
    return true;
  }

  /** Fill and empty the cells that changed in a chunk's collider, passing border changes on to its neighbours. */
  private editChunk(ch: VoxelChunkState<Dim2>, chunks: Map<string, VoxelChunkState<Dim2>>, place: Placement, size: number, version: string, solid: Uint8Array): void {
    const map = cellMapping(place, size, ch.cx, ch.cy);
    const changes: VoxelChange2D[] = [];
    let border = false;
    for (let i = 0; i < solid.length; i++) {
      const filled = solid[i] !== 0;
      if (filled === (ch.solid[i] !== 0)) continue;
      changes.push({ x: map.x(i), y: map.y(i), filled });
      const lx = i % size, ly = (i / size) | 0;
      if (lx === 0 || ly === 0 || lx === size - 1 || ly === size - 1) border = true;
    }
    ch.version = version;
    ch.solid.set(solid);
    if (changes.length) this.host.backend.setVoxels!(ch.collider, changes, border ? links2D(neighbours(chunks, ch.cx, ch.cy)) : []);
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

/** What has to stay the same for voxel colliders to be edited in place: the cells' unit and chunk size. */
function latticeOf(cells: CollisionCells2D): string {
  return `${cells.unit.x},${cells.unit.y},${cells.chunkSize}`;
}

/**
 * A chunk's cell index → its voxel coordinates in the group's frame: the group's cell (x, y) is voxel (x, y), or
 * (−x − 1) along an axis the node's scale mirrors (voxels have a positive size).
 */
function cellMapping(place: Placement, size: number, cx: number, cy: number): { x(i: number): number; y(i: number): number } {
  const bx = cx * size, by = cy * size;
  const fx = place.sx < 0, fy = place.sy < 0;
  return {
    x: (i) => {
      const x = bx + (i % size);
      return fx ? -x - 1 : x;
    },
    y: (i) => {
      const y = by + ((i / size) | 0);
      return fy ? -y - 1 : y;
    },
  };
}

/** The chunk colliders around (cx, cy), corners included. */
function neighbours(chunks: Map<string, VoxelChunkState<Dim2>>, cx: number, cy: number): VoxelChunkState<Dim2>[] {
  const out: VoxelChunkState<Dim2>[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const n = chunks.get(`${cx + dx},${cy + dy}`);
      if (n) out.push(n);
    }
  }
  return out;
}

/** Neighbouring chunk colliders as links: they share the group's origin, so no shift. */
function links2D(chunks: readonly VoxelChunkState<Dim2>[]): VoxelLink2D[] {
  return chunks.map((n) => ({ collider: n.collider, shift: NO_SHIFT }));
}

/** Whether two shape sets are the same shapes (the source's shapes beside its cells, between two edits). */
function sameShapes(a: CollisionShapes2D, b: CollisionShapes2D | null): boolean {
  if (!b || a.unit.x !== b.unit.x || a.unit.y !== b.unit.y) return false;
  const sameRects = (p: readonly Rect[], q: readonly Rect[]) => p.length === q.length && p.every((r, i) => r.x === q[i].x && r.y === q[i].y && r.w === q[i].w && r.h === q[i].h);
  const samePolys = (p: readonly [number, number][][], q: readonly [number, number][][]) =>
    p.length === q.length && p.every((poly, i) => poly.length === q[i].length && poly.every((pt, j) => pt[0] === q[i][j][0] && pt[1] === q[i][j][1]));
  return sameRects(a.boxes, b.boxes) && sameRects(a.oneWay, b.oneWay) && samePolys(a.polygons, b.polygons) && samePolys(a.oneWayPolygons, b.oneWayPolygons) && samePolys(a.loops, b.loops);
}
