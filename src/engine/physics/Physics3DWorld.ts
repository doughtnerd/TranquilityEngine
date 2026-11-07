/**
 * Rapier 3D physics backend (ADR 0005, 0045). Internal: game code uses RigidBody, the 3D colliders
 * and the Physics facade. Loaded on demand by `ensurePhysics3D` (physics3d.ts).
 *
 * The same sync rules as 2D (ADR 0010):
 * - dynamic bodies: physics → Transform after each step; if a script moved the Transform since
 *   the last write-back, the body is teleported before the step.
 * - kinematic bodies: Transform → physics before each step.
 * - static bodies and colliders without a body: pushed when their Transform changes.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import { GameBehavior } from "../core/Component";
import { DEG2RAD, Mat4, Quat, Quaternion, Vector3, type QuatLike } from "../core/math";
import type { World } from "../core/World";
import { MeshRenderer } from "../render/components";
import { meshesIfLoaded, meshTriangles, type ModelMesh } from "../scene/models";
import { BoxCollider, CapsuleCollider, Collider, MeshCollider, SphereCollider, type Collision } from "./Collider";
import { layerGroups } from "./layers";
import { Queries3D } from "./queries3d";
import { CollisionEvents, TriggerEvents } from "./physics3d";
import { RigidBody } from "./RigidBody";
import { AXIS_INDEX, boxHalfExtents, capsuleSize, scaledCenter, sphereRadius } from "./shape3d";

/** @internal */
export interface BodyHandleState3D {
  body: RAPIER.RigidBody;
  signature: string;
  syncedVersion: number;
  active: boolean;
  /** Interpolation (ADR 0093): the body's pose before and after the last step, `[x, y, z, qx, qy, qz, qw]`. */
  prev: number[] | null;
  curr: number[] | null;
  /** True while the Transform shows an interpolated pose rather than `curr`. */
  interpolated: boolean;
}

/** @internal */
export interface ColliderHandleState3D {
  collider: RAPIER.Collider;
  body: RigidBody | null;
  signature: string;
  syncedVersion: number;
  active: boolean;
  /** A mesh collider's meshes, to rebuild it when its model loads again. */
  meshes: readonly ModelMesh[] | null;
  /** A collider on a body's descendant: its pose relative to the body, to follow the node when it moves (ADR 0093). */
  local: number[] | null;
}

let rapierReady: Promise<void> | null = null;

/** @internal Initialize Rapier 3D's WASM once. */
export function initRapier3D(): Promise<void> {
  return (rapierReady ??= RAPIER.init().catch((err: unknown) => {
    rapierReady = null; // tried again next time
    throw err;
  }));
}

const pos = [0, 0, 0];
const rot = [0, 0, 0, 1];
const scl = [1, 1, 1];

/** A node's world position, rotation and (positive) scale. */
function worldPose(world: World, entity: number): { p: Vector3; q: Quaternion; s: [number, number, number] } {
  Mat4.decompose(world.worldMatrix(entity), entity * 16, pos, 0, rot, 0, scl, 0);
  return { p: new Vector3(pos[0], pos[1], pos[2]), q: new Quaternion(rot[0], rot[1], rot[2], rot[3]), s: [Math.abs(scl[0]), Math.abs(scl[1]), Math.abs(scl[2])] };
}

/** Rapier capsules lie along Y: the turn that lays one along X or Z. */
const CAPSULE_TURN: Record<"x" | "y" | "z", Quaternion> = {
  x: Quat.fromAxisAngle(0, 0, 1, -Math.PI / 2),
  y: new Quaternion(),
  z: Quat.fromAxisAngle(1, 0, 0, Math.PI / 2),
};

/** A quaternion as Rapier takes it (a plain object: Rapier reads fields, not getters). */
const rapierRotation = (q: QuatLike): RAPIER.Rotation => ({ x: q.x, y: q.y, z: q.z, w: q.w });

/** Normalized lerp between the rotations in two `[x, y, z, qx, qy, qz, qw]` poses, the short way round. */
function nlerp(a: readonly number[], b: readonly number[], t: number): Quaternion {
  const s = a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6] < 0 ? -1 : 1;
  const x = a[3] + (b[3] * s - a[3]) * t, y = a[4] + (b[4] * s - a[4]) * t, z = a[5] + (b[5] * s - a[5]) * t, w = a[6] + (b[6] * s - a[6]) * t;
  const len = Math.hypot(x, y, z, w) || 1;
  return new Quaternion(x / len, y / len, z / len, w / len);
}

/** @internal */
export class Physics3DWorld {
  readonly rapier: RAPIER.World;
  /** @internal */
  readonly queries: Queries3D;
  private readonly events = new RAPIER.EventQueue(true);
  private readonly colliderByHandle = new Map<number, Collider>();
  private readonly layerGroups: Map<string, number>;
  private readonly warned = new Set<string>();

  constructor(private readonly world: World) {
    const g = world.settings.physics.gravity as readonly number[];
    this.rapier = new RAPIER.World({ x: g[0] ?? 0, y: g[1] ?? -9.81, z: g[2] ?? 0 });
    this.layerGroups = layerGroups(world.settings.physics);
    this.queries = new Queries3D(this.rapier, (h) => this.colliderByHandle.get(h), (l) => this.groupsFor(l));
  }

  get gravity(): { x: number; y: number; z: number } {
    const g = this.rapier.gravity;
    return { x: g.x, y: g.y, z: g.z };
  }
  set gravity(g: { x: number; y: number; z: number }) {
    this.rapier.gravity = { x: g.x, y: g.y, z: g.z };
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }

  private groupsFor(layer: string): number {
    const g = this.layerGroups.get(layer);
    if (g === undefined) {
      this.warnOnce(`layer:${layer}`, `unknown physics layer "${layer}"; using "${this.world.settings.physics.layers[0]}".`);
      return this.layerGroups.get(this.world.settings.physics.layers[0])!;
    }
    return g;
  }

  // --- fixed-step stages -------------------------------------------------------------------------

  /** @internal */
  push(): void {
    for (const rb of this.world._componentsOfType(RigidBody)) this.pushBody(rb);
    for (const c of this.world._componentsOfType(Collider)) this.pushCollider(c);
  }

  private bodySignature(rb: RigidBody): string {
    const c = rb.constraints, fp = c?.freezePosition, fr = c?.freezeRotation;
    return [rb.bodyType, rb.mass, rb.useGravity, rb.gravityScale, rb.drag, rb.angularDrag, fp?.x, fp?.y, fp?.z, fr?.x, fr?.y, fr?.z, rb.collisionDetection].join("|");
  }

  private pushBody(rb: RigidBody): void {
    const active = rb.isActiveAndEnabled;
    let st = rb._state;
    if (!st) {
      if (!active) return;
      st = rb._state = this.createBody(rb);
    }
    if (st.active !== active) {
      st.active = active;
      st.body.setEnabled(active);
    }
    if (!active) return;
    const body = st.body;
    const sig = this.bodySignature(rb);
    if (sig !== st.signature) {
      this.applyBodySettings(rb, body);
      st.signature = sig;
    }
    const e = rb.node.entity;
    const version = this.world.tVersion[e];
    if (rb.node.transform && version !== st.syncedVersion) {
      const { p, q } = worldPose(this.world, e);
      if (rb.bodyType === "kinematic") {
        body.setNextKinematicTranslation(p);
        body.setNextKinematicRotation(q);
      } else {
        body.setTranslation(p, true);
        body.setRotation(q, true);
        st.prev = st.curr = null; // teleported: nothing to blend from
      }
      st.interpolated = false;
      st.syncedVersion = version;
    }
    if (rb._pendingVelocity) {
      const [x, y, z] = rb._pendingVelocity;
      body.setLinvel({ x, y, z }, true);
      rb._pendingVelocity = null;
    }
    if (rb._pendingAngularVelocity) {
      const [x, y, z] = rb._pendingAngularVelocity;
      body.setAngvel({ x: x * DEG2RAD, y: y * DEG2RAD, z: z * DEG2RAD }, true);
      rb._pendingAngularVelocity = null;
    }
    // "force" mode applies for exactly one step (Unity semantics); Rapier forces persist until reset.
    body.resetForces(false);
    body.resetTorques(false);
    const [fx, fy, fz] = rb._force, [tx, ty, tz] = rb._torque;
    if (fx || fy || fz) body.addForce({ x: fx, y: fy, z: fz }, true);
    if (tx || ty || tz) body.addTorque({ x: tx, y: ty, z: tz }, true);
    rb._force.fill(0);
    rb._torque.fill(0);
  }

  private createBody(rb: RigidBody): BodyHandleState3D {
    const { p, q } = rb.node.transform ? worldPose(this.world, rb.node.entity) : { p: new Vector3(), q: new Quaternion() };
    const desc = rb.bodyType === "static" ? RAPIER.RigidBodyDesc.fixed() : rb.bodyType === "kinematic" ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic();
    desc.setTranslation(p.x, p.y, p.z).setRotation(rapierRotation(q));
    const body = this.rapier.createRigidBody(desc);
    this.applyBodySettings(rb, body);
    return { body, signature: this.bodySignature(rb), syncedVersion: this.world.tVersion[rb.node.entity], active: true, prev: null, curr: null, interpolated: false };
  }

  private applyBodySettings(rb: RigidBody, body: RAPIER.RigidBody): void {
    const type = rb.bodyType === "static" ? RAPIER.RigidBodyType.Fixed : rb.bodyType === "kinematic" ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic;
    if (body.bodyType() !== type) body.setBodyType(type, true);
    body.setGravityScale(rb.useGravity ? rb.gravityScale : 0, true);
    body.setLinearDamping(rb.drag);
    body.setAngularDamping(rb.angularDrag);
    const fp = rb.constraints?.freezePosition, fr = rb.constraints?.freezeRotation;
    body.setEnabledTranslations(!fp?.x, !fp?.y, !fp?.z, true);
    body.setEnabledRotations(!fr?.x, !fr?.y, !fr?.z, true);
    body.enableCcd(rb.collisionDetection === "continuous");
    // Colliders on bodies have zero density; the body's mass comes from `mass` (box-ish inertia).
    const mass = Math.max(rb.mass, 1e-4);
    body.setAdditionalMassProperties(mass, { x: 0, y: 0, z: 0 }, { x: mass / 6, y: mass / 6, z: mass / 6 }, { x: 0, y: 0, z: 0, w: 1 }, true);
  }

  /** Each collider's world scale and the transform version it was read at, so it's read only when the node moved. */
  private readonly scales = new WeakMap<Collider, { version: number; scale: [number, number, number] }>();

  private worldScale(c: Collider, e: number): readonly number[] {
    if (!c.node.transform) return [1, 1, 1];
    const version = this.world.tVersion[e];
    const cached = this.scales.get(c);
    if (cached && cached.version === version) return cached.scale;
    Mat4.decompose(this.world.worldMatrix(e), e * 16, pos, 0, rot, 0, scl, 0);
    const scale: [number, number, number] = [Math.abs(scl[0]), Math.abs(scl[1]), Math.abs(scl[2])];
    this.scales.set(c, { version, scale });
    return scale;
  }

  /** The meshes a MeshCollider takes its shape from: its own mesh, else its node's MeshRenderer's. Null while loading. */
  private colliderMeshes(c: MeshCollider): readonly ModelMesh[] | null {
    const ref = c.mesh || c.node.getBehavior(MeshRenderer)?.mesh || "";
    if (!ref) {
      this.warnOnce(`nomesh:${c.node.entity}`, `${c.node.name}: MeshCollider has no mesh and no MeshRenderer to take one from.`);
      return [];
    }
    return meshesIfLoaded(ref);
  }

  private pushCollider(c: Collider): void {
    const active = c.isActiveAndEnabled;
    const body = active ? c.attachedRigidbody : null;
    const e = c.node.entity;
    const ws = this.worldScale(c, e);
    const signature = [c._shapeSignature(), c.isTrigger, c.layer, c.material?.friction, c.material?.bounciness, ...ws.map((v) => v.toFixed(4)), c.center.x, c.center.y, c.center.z].join("|");
    const meshes = c instanceof MeshCollider && active ? this.colliderMeshes(c) : null;
    if (c instanceof MeshCollider && active && meshes === null) return; // its model is loading

    let st = c._state;
    const meshesChanged = st && meshes && (st.meshes?.length !== meshes.length || meshes.some((m, i) => st!.meshes![i] !== m));
    if (st && (st.body !== body || st.signature !== signature || (body && !body._state) || meshesChanged)) {
      this.releaseCollider(c);
      st = null;
    }
    if (!st) {
      if (!active) return;
      if (body && !body._state) return; // its body is created in the same pass, earlier
      st = c._state = this.createCollider(c, body, signature, meshes, ws);
    }
    if (st.active !== active) {
      st.active = active;
      st.collider.setEnabled(active);
    }
    if (!active) return;
    const version = this.world.tVersion[e];
    if (body) {
      // A collider on a descendant of its body's node follows the node when it moves relative to the body.
      if (body.node.entity !== e && version !== st.syncedVersion) {
        const rel = this.poseInBody(c, body, ws);
        const local = [rel.p.x, rel.p.y, rel.p.z, rel.q.x, rel.q.y, rel.q.z, rel.q.w];
        if (!st.local || local.some((v, i) => Math.abs(v - st!.local![i]) > 1e-5)) {
          st.collider.setTranslationWrtParent(rel.p);
          st.collider.setRotationWrtParent(rapierRotation(rel.q));
          st.local = local;
        }
        st.syncedVersion = version;
      }
      return;
    }
    if (version !== st.syncedVersion) {
      const pose = this.colliderWorldPose(c, ws);
      st.collider.setTranslation(pose.p);
      st.collider.setRotation(pose.q);
      st.syncedVersion = version;
    }
  }

  /** World pose of the collider's shape: the node's pose plus its turned, scaled `center` (and a capsule's axis). */
  private colliderWorldPose(c: Collider, ws: readonly number[]): { p: Vector3; q: Quaternion } {
    if (!c.node.transform) return { p: new Vector3(c.center.x, c.center.y, c.center.z), q: new Quaternion() };
    const { p, q } = worldPose(this.world, c.node.entity);
    const offset = Quat.rotate(q, new Vector3(...scaledCenter([c.center.x, c.center.y, c.center.z], ws)));
    const turn = c instanceof CapsuleCollider ? CAPSULE_TURN[c.direction] ?? CAPSULE_TURN.y : null;
    return { p: p.add(offset), q: turn ? q.clone().multiply(turn) : q };
  }

  private createCollider(c: Collider, body: RigidBody | null, signature: string, meshes: readonly ModelMesh[] | null, ws: readonly number[]): ColliderHandleState3D {
    let desc: RAPIER.ColliderDesc;
    if (c instanceof BoxCollider) {
      const [hx, hy, hz] = boxHalfExtents([c.size.x, c.size.y, c.size.z], ws);
      desc = RAPIER.ColliderDesc.cuboid(Math.max(hx, 1e-4), Math.max(hy, 1e-4), Math.max(hz, 1e-4));
    } else if (c instanceof SphereCollider) {
      desc = RAPIER.ColliderDesc.ball(Math.max(sphereRadius(c.radius, ws), 1e-4));
    } else if (c instanceof CapsuleCollider) {
      const { radius, halfHeight } = capsuleSize(c.radius, c.height, AXIS_INDEX[c.direction] ?? 1, ws);
      desc = RAPIER.ColliderDesc.capsule(halfHeight, Math.max(radius, 1e-4));
    } else if (c instanceof MeshCollider) {
      desc = this.meshShape(c, meshes ?? [], ws, body);
    } else {
      throw new Error(`Unsupported collider type ${c.constructor.name}.`);
    }
    let local: number[] | null = null;
    if (body?._state) {
      // Placed relative to the body, in the body's turned frame.
      const rel = this.poseInBody(c, body, ws);
      desc.setTranslation(rel.p.x, rel.p.y, rel.p.z).setRotation(rapierRotation(rel.q)).setDensity(0);
      local = [rel.p.x, rel.p.y, rel.p.z, rel.q.x, rel.q.y, rel.q.z, rel.q.w];
    } else {
      const pose = this.colliderWorldPose(c, ws);
      desc.setTranslation(pose.p.x, pose.p.y, pose.p.z).setRotation(rapierRotation(pose.q));
    }
    desc
      .setSensor(c.isTrigger)
      .setFriction(c.material?.friction ?? 0.5)
      .setRestitution(c.material?.bounciness ?? 0)
      .setCollisionGroups(this.groupsFor(c.layer))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED);
    const collider = this.rapier.createCollider(desc, body?._state?.body);
    this.colliderByHandle.set(collider.handle, c);
    return { collider, body, signature, syncedVersion: this.world.tVersion[c.node.entity], active: true, meshes, local };
  }

  /**
   * The collider's shape pose in its body's frame, from the two nodes' Transforms (not the Rapier
   * body, whose pose an interpolated Transform may lag behind; the two nodes lag together).
   */
  private poseInBody(c: Collider, body: RigidBody, ws: readonly number[]): { p: Vector3; q: Quaternion } {
    const pose = this.colliderWorldPose(c, ws);
    const b = body.node.transform ? worldPose(this.world, body.node.entity) : { p: new Vector3(), q: new Quaternion() };
    const inv = Quat.conjugate(b.q);
    return { p: Quat.rotate(inv, pose.p.clone().sub(b.p)), q: inv.multiply(pose.q) };
  }

  /** A mesh collider's shape: the meshes' triangles, scaled with the node, exact or wrapped in their convex hull. */
  private meshShape(c: MeshCollider, meshes: readonly ModelMesh[], ws: readonly number[], body: RigidBody | null): RAPIER.ColliderDesc {
    const verts: number[] = [], tris: number[] = [];
    for (const m of meshes) {
      const { vertices, indices } = meshTriangles(m);
      const base = verts.length / 3;
      for (let i = 0; i < vertices.length; i += 3) verts.push(vertices[i] * ws[0], vertices[i + 1] * ws[1], vertices[i + 2] * ws[2]);
      for (const i of indices) tris.push(base + i);
    }
    if (verts.length < 9) {
      this.warnOnce(`empty:${c.node.entity}`, `${c.node.name}: MeshCollider's mesh has no triangles.`);
      return RAPIER.ColliderDesc.ball(1e-4);
    }
    if (c.convex) {
      const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(verts));
      if (hull) return hull;
      this.warnOnce(`hull:${c.node.entity}`, `${c.node.name}: MeshCollider's mesh has no convex hull (it's flat); colliding with its triangles.`);
    } else if (body && body.bodyType === "dynamic") {
      this.warnOnce(`concave:${c.node.entity}`, `${c.node.name}: a MeshCollider on a dynamic RigidBody should be convex; exact meshes only collide with other shapes.`);
    }
    return RAPIER.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(tris));
  }

  /** @internal */
  step(dt: number): void {
    this.rapier.timestep = dt;
    this.rapier.step(this.events);
  }

  /** @internal */
  writeBack(): void {
    for (const rb of this.world._componentsOfType(RigidBody)) {
      const st = rb._state;
      if (!st || !st.active || rb.bodyType !== "dynamic") continue;
      if (st.body.isSleeping()) {
        if (st.curr) st.prev = st.curr; // at rest: nothing left to blend
        continue;
      }
      const t = rb.node.transform;
      if (!t) continue;
      const p = st.body.translation(), r = st.body.rotation();
      if (rb.interpolate) {
        const pose = [p.x, p.y, p.z, r.x, r.y, r.z, r.w];
        st.prev = st.curr ?? pose;
        st.curr = pose;
      } else {
        st.prev = st.curr = null;
      }
      t._setWorldPose3D(p.x, p.y, p.z, new Quaternion(r.x, r.y, r.z, r.w));
      st.interpolated = false;
      st.syncedVersion = this.world.tVersion[rb.node.entity];
    }
  }

  /**
   * @internal Interpolation (ADR 0093), in Worlds that render: show each interpolating dynamic body
   * `alpha` of the way from its pose before the last step to its pose after it.
   */
  interpolate(alpha: number): void {
    for (const rb of this.world._componentsOfType(RigidBody)) {
      const st = rb._state;
      if (!st?.prev || !st.curr || !st.active || !rb.interpolate || rb.bodyType !== "dynamic") continue;
      const t = rb.node.transform;
      if (!t || this.world.tVersion[rb.node.entity] !== st.syncedVersion) continue; // a script moved it: that wins
      const a = st.prev, b = st.curr;
      if (a === b && !st.interpolated) continue; // at rest and already showing it
      const q = nlerp(a, b, alpha);
      t._setWorldPose3D(a[0] + (b[0] - a[0]) * alpha, a[1] + (b[1] - a[1]) * alpha, a[2] + (b[2] - a[2]) * alpha, q);
      st.interpolated = true;
      st.syncedVersion = this.world.tVersion[rb.node.entity];
    }
  }

  /** @internal Before a fixed step's scripts: put interpolated bodies back at their simulated pose. */
  restoreInterpolated(): void {
    for (const rb of this.world._componentsOfType(RigidBody)) {
      const st = rb._state;
      if (!st?.interpolated || !st.curr) continue;
      st.interpolated = false;
      const t = rb.node.transform;
      if (!t || this.world.tVersion[rb.node.entity] !== st.syncedVersion) continue;
      const c = st.curr;
      t._setWorldPose3D(c[0], c[1], c[2], new Quaternion(c[3], c[4], c[5], c[6]));
      st.syncedVersion = this.world.tVersion[rb.node.entity];
    }
  }

  /** Pairs of colliders touching (or overlapping, for triggers) since an earlier step, for `Stay` hooks (ADR 0093). */
  private readonly touching = new Map<string, { h1: number; h2: number; fresh: boolean }>();

  /** @internal */
  dispatchEvents(): void {
    this.events.drainCollisionEvents((h1, h2, started) => {
      const key = h1 < h2 ? `${h1}:${h2}` : `${h2}:${h1}`;
      if (started) this.touching.set(key, { h1, h2, fresh: true });
      else this.touching.delete(key);
      const a = this.colliderByHandle.get(h1), b = this.colliderByHandle.get(h2);
      if (!a || !b || a._destroyed || b._destroyed) return;
      const trigger = a.isTrigger || b.isTrigger;
      this.world._buffer(trigger ? TriggerEvents : CollisionEvents).push({ a, b, started });
      this.notify(a, b, trigger, started ? "Enter" : "Exit");
      this.notify(b, a, trigger, started ? "Enter" : "Exit");
    });
    // onCollisionStay / onTriggerStay: every step after the one that began the contact, while it lasts.
    for (const [key, pair] of this.touching) {
      if (pair.fresh) {
        pair.fresh = false;
        continue;
      }
      const a = this.colliderByHandle.get(pair.h1), b = this.colliderByHandle.get(pair.h2);
      if (!a || !b || a._destroyed || b._destroyed) {
        this.touching.delete(key);
        continue;
      }
      if (!a.isActiveAndEnabled || !b.isActiveAndEnabled) continue;
      const trigger = a.isTrigger || b.isTrigger;
      this.notify(a, b, trigger, "Stay");
      this.notify(b, a, trigger, "Stay");
    }
  }

  /** Call the hook on active behaviors of `self`'s node, owner and body node. */
  private notify(self: Collider, other: Collider, trigger: boolean, phase: "Enter" | "Stay" | "Exit"): void {
    const nodes = new Set([self.node.entity, self.owner.entity]);
    const body = self._state?.body;
    if (body?.node.isValid) nodes.add(body.node.entity);
    const hook = `${trigger ? "onTrigger" : "onCollision"}${phase}`;
    const collision: Collision | null = trigger ? null : { collider: other, otherCollider: self, gameObject: other.owner, rigidbody: other._state?.body ?? null };
    for (const e of nodes) {
      for (const comp of [...this.world._componentsOf(e)]) {
        if (!(comp instanceof GameBehavior) || !comp.isActiveAndEnabled) continue;
        const fn = (comp as unknown as Record<string, ((arg: unknown) => void) | undefined>)[hook];
        if (!fn) continue;
        try {
          fn.call(comp, trigger ? other : collision);
        } catch (err) {
          console.error(`[myco] ${comp.constructor.name}.${hook} threw:`, err);
        }
      }
    }
  }

  // --- queries -----------------------------------------------------------------------------------

  /** @internal */
  raycast(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxDistance: number, layers?: string[]) {
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const ray = new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x / len, y: dir.y / len, z: dir.z / len });
    let groups: number | undefined;
    if (layers?.length) groups = (0xffff << 16) | layers.reduce((m, l) => m | (this.groupsFor(l) >>> 16), 0);
    const hit = this.rapier.castRayAndGetNormal(ray, maxDistance, true, undefined, groups);
    if (!hit) return null;
    const collider = this.colliderByHandle.get(hit.collider.handle);
    if (!collider) return null;
    const point = ray.pointAt(hit.timeOfImpact);
    return { collider, point: { x: point.x, y: point.y, z: point.z }, normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z }, distance: hit.timeOfImpact };
  }

  // --- release -----------------------------------------------------------------------------------

  /** @internal */
  releaseBody(rb: RigidBody): void {
    const st = rb._state;
    if (!st) return;
    for (const c of this.world._componentsOfType(Collider)) if (c._state?.body === rb) this.releaseCollider(c);
    this.rapier.removeRigidBody(st.body);
    rb._state = null;
  }

  /** @internal */
  releaseCollider(c: Collider): void {
    const st = c._state;
    if (!st) return;
    const h = st.collider.handle;
    this.colliderByHandle.delete(h);
    for (const [key, pair] of this.touching) if (pair.h1 === h || pair.h2 === h) this.touching.delete(key);
    if (this.rapier.getCollider(h)) this.rapier.removeCollider(st.collider, true);
    c._state = null;
  }
}
