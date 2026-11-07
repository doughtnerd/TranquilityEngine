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
import { CharacterController, type CollisionFlags, type ControllerColliderHit } from "./CharacterController";
import { AxisJoint, BallJoint, FixedJoint, HingeJoint, Joint, RopeJoint, SliderJoint, SpringJoint } from "./Joint";
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
  /** A character controller's own kinematic body, which carries its collider (ADR 0091). */
  ownBody?: RAPIER.RigidBody;
}

/** @internal */
export interface JointHandleState3D {
  joint: RAPIER.ImpulseJoint;
  signature: string;
  settings: string;
  body: RigidBody;
  connected: RigidBody | null;
  /** The fixed body standing in for the world, when the joint isn't connected to a body. */
  ground: RAPIER.RigidBody | null;
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

/** How hard a joint motor drives towards its target velocity, before its `force` limit. */
const MOTOR_GAIN = 1e4;

/** The shortest turn taking the x axis onto unit vector `v`. */
function fromXTo(v: Vector3): Quaternion {
  const d = v.x;
  if (d < -0.999999) return new Quaternion(0, 1, 0, 0); // half a turn around y
  const q = new Quaternion(0, -v.z, v.y, 1 + d); // cross((1,0,0), v), 1 + dot
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  return new Quaternion(q.x / len, q.y / len, q.z / len, q.w / len);
}

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
    for (const j of this.world._componentsOfType(Joint)) this.pushJoint(j);
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
    if (version !== st.syncedVersion && st.ownBody) {
      st.ownBody.setTranslation(this.colliderWorldPose(c, ws).p, true);
      this.rapier.propagateModifiedBodyPositionsToColliders();
      st.syncedVersion = version;
    } else if (version !== st.syncedVersion) {
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
    // A character controller's capsule stays upright, whichever way its node turns.
    if (c instanceof CharacterController) return { p: p.add(new Vector3(...scaledCenter([c.center.x, c.center.y, c.center.z], ws))), q: new Quaternion() };
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
    } else if (c instanceof CharacterController) {
      const { radius, halfHeight } = capsuleSize(c.radius, c.height, 1, ws);
      desc = RAPIER.ColliderDesc.capsule(halfHeight, Math.max(radius, 1e-4));
    } else if (c instanceof MeshCollider) {
      desc = this.meshShape(c, meshes ?? [], ws, body);
    } else {
      throw new Error(`Unsupported collider type ${c.constructor.name}.`);
    }
    let local: number[] | null = null;
    let ownBody: RAPIER.RigidBody | undefined;
    if (c instanceof CharacterController) {
      // On its own kinematic body, so it meets static triggers and level geometry (static–static pairs never do).
      const pose = this.colliderWorldPose(c, ws);
      ownBody = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pose.p.x, pose.p.y, pose.p.z));
    } else if (body?._state) {
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
      // A character controller is a parentless collider that moves: it must meet static triggers too.
      .setActiveCollisionTypes(c instanceof CharacterController ? RAPIER.ActiveCollisionTypes.ALL : RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED);
    const collider = this.rapier.createCollider(desc, ownBody ?? body?._state?.body);
    this.colliderByHandle.set(collider.handle, c);
    return { collider, body, signature, syncedVersion: this.world.tVersion[c.node.entity], active: true, meshes, local, ownBody };
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

  // --- joints (ADR 0092) ---------------------------------------------------------------------------

  private pushJoint(j: Joint): void {
    const active = j.isActiveAndEnabled;
    const body = active ? j.body : null;
    const connected = active ? j.connectedRigidbody : null;
    if (active && !body) this.warnOnce(`jointbody:${j.node.entity}`, `${j.node.name}: ${j.constructor.name} needs a RigidBody on its node or above it.`);
    if (active && j.connectedBody?.isValid && !connected) this.warnOnce(`jointother:${j.node.entity}`, `${j.node.name}: ${j.constructor.name}'s connected node "${j.connectedBody.name}" has no RigidBody.`);
    const a = j.anchor, ca = j.connectedAnchor;
    const signature = [j._jointSignature(), a.x, a.y, a.z, j.autoConfigureConnectedAnchor, ca.x, ca.y, ca.z, j.connectedBody?.isValid ? j.connectedBody.entity : -1, j.enableCollision].join("|");
    let st = j._state;
    if (st && (!active || st.signature !== signature || st.body !== body || st.connected !== connected || !st.body._state || (st.connected && !st.connected._state))) {
      this.releaseJoint(j);
      st = null;
    }
    if (!st) {
      if (!active || !body?._state || (j.connectedBody?.isValid && !connected?._state)) return;
      st = j._state = this.createJoint(j, body, connected, signature);
    }
    const settings = j._settingsSignature();
    if (settings !== st.settings) {
      st.settings = settings;
      this.applyJointSettings(j, st);
    }
  }

  /** A point in a node's local space, in world space. */
  private pointOf(node: Joint["node"], local: { x: number; y: number; z: number }): Vector3 {
    if (!node.transform) return new Vector3(local.x, local.y, local.z);
    const [x, y, z] = Mat4.transformPoint(this.world.worldMatrix(node.entity), node.entity * 16, local.x, local.y, local.z);
    return new Vector3(x, y, z);
  }

  private createJoint(j: Joint, body: RigidBody, connected: RigidBody | null, signature: string): JointHandleState3D {
    const pose1 = body.node.transform ? worldPose(this.world, body.node.entity) : { p: new Vector3(), q: new Quaternion() };
    const pw = this.pointOf(j.node, j.anchor);
    let rb2: RAPIER.RigidBody, ground: RAPIER.RigidBody | null = null, pose2: { p: Vector3; q: Quaternion };
    if (connected) {
      rb2 = connected._state!.body;
      pose2 = connected.node.transform ? worldPose(this.world, connected.node.entity) : { p: new Vector3(), q: new Quaternion() };
    } else {
      // The world: a fixed body where this body is now, so the two frames start out matching.
      ground = rb2 = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(pose1.p.x, pose1.p.y, pose1.p.z).setRotation(rapierRotation(pose1.q)));
      pose2 = pose1;
    }
    // The connected anchor: where the anchor is now, or `connectedAnchor`. Ropes and springs auto-anchor at the connected body's origin.
    const distanceJoint = j instanceof RopeJoint || j instanceof SpringJoint;
    let pw2: Vector3;
    if (!j.autoConfigureConnectedAnchor) pw2 = connected ? this.pointOf(j.connectedBody!, j.connectedAnchor) : new Vector3(j.connectedAnchor.x, j.connectedAnchor.y, j.connectedAnchor.z);
    else if (distanceJoint && connected) pw2 = pose2.p.clone();
    else pw2 = pw.clone();
    const inv1 = Quat.conjugate(pose1.q), inv2 = Quat.conjugate(pose2.q);
    const a1 = Quat.rotate(inv1, pw.clone().sub(pose1.p)), a2 = Quat.rotate(inv2, pw2.clone().sub(pose2.p));
    // The joint's frame in world space: its x axis along the hinge or slider axis. Each body holds it in its own frame.
    const nodeQ = j.node.transform ? worldPose(this.world, j.node.entity).q : new Quaternion();
    const ax = j instanceof AxisJoint || j instanceof BallJoint ? j.axis : { x: 1, y: 0, z: 0 };
    const len = Math.hypot(ax.x, ax.y, ax.z) || 1;
    const frame = fromXTo(Quat.rotate(nodeQ, new Vector3(ax.x / len, ax.y / len, ax.z / len)));
    const f1 = rapierRotation(Quat.conjugate(pose1.q).multiply(frame)), f2 = rapierRotation(Quat.conjugate(pose2.q).multiply(frame));
    const dist = pw2.clone().sub(pw).length;
    // Rapier's first body is the connected one, so angles and positions read as this body's relative to it.
    let data: RAPIER.JointData;
    if (j instanceof FixedJoint) data = RAPIER.JointData.fixed(a2, f2, a1, f1);
    else if (j instanceof HingeJoint) data = RAPIER.JointData.revolute(a2, a1, { x: 1, y: 0, z: 0 });
    else if (j instanceof SliderJoint) data = RAPIER.JointData.prismatic(a2, a1, { x: 1, y: 0, z: 0 });
    else if (j instanceof BallJoint) data = RAPIER.JointData.spherical(a2, a1);
    else if (j instanceof RopeJoint) data = RAPIER.JointData.rope(j.autoConfigureDistance ? dist : Math.max(j.maxDistance, 0), a2, a1);
    else if (j instanceof SpringJoint) data = RAPIER.JointData.spring(j.autoConfigureDistance ? dist : Math.max(j.restLength, 0), j.spring, j.damper, a2, a1);
    else throw new Error(`Unsupported joint type ${j.constructor.name}.`);
    if (j instanceof AxisJoint && j.useLimits) {
      const k = j instanceof HingeJoint ? DEG2RAD : 1;
      data.limitsEnabled = true;
      data.limits = [Math.min(j.limits.min, j.limits.max) * k, Math.max(j.limits.min, j.limits.max) * k];
    }
    const joint = this.rapier.createImpulseJoint(data, rb2, body._state!.body, true);
    if (j instanceof HingeJoint || j instanceof SliderJoint || j instanceof BallJoint) {
      joint.setLocalFrame1(a2, f2);
      joint.setLocalFrame2(a1, f1);
    }
    joint.setContactsEnabled(j.enableCollision);
    return { joint, signature, settings: "", body, connected, ground };
  }

  /** Limits, motor and spring on a live hinge or slider. */
  private applyJointSettings(j: Joint, st: JointHandleState3D): void {
    if (j instanceof BallJoint) {
      if (!j.useLimits) return;
      // Per-axis angular limits through the raw joint set (the JS class only exposes them on hinges and sliders).
      const raw = (st.joint as unknown as { rawSet: { jointSetLimits(h: number, axis: number, min: number, max: number): void } }).rawSet;
      const t = j.twistLimits ?? { min: 0, max: 0 }, swing = Math.abs(j.swingLimit) * DEG2RAD;
      raw.jointSetLimits(st.joint.handle, RAPIER.JointAxis.AngX, Math.min(t.min, t.max) * DEG2RAD, Math.max(t.min, t.max) * DEG2RAD);
      raw.jointSetLimits(st.joint.handle, RAPIER.JointAxis.AngY, -swing, swing);
      raw.jointSetLimits(st.joint.handle, RAPIER.JointAxis.AngZ, -swing, swing);
      st.body._state?.body.wakeUp();
      return;
    }
    if (!(j instanceof AxisJoint)) return;
    const unit = st.joint as RAPIER.UnitImpulseJoint;
    const k = j instanceof HingeJoint ? DEG2RAD : 1;
    if (j.useLimits) unit.setLimits(Math.min(j.limits.min, j.limits.max) * k, Math.max(j.limits.min, j.limits.max) * k);
    if (j.useMotor || j.useSpring) unit.configureMotorModel(RAPIER.MotorModel.ForceBased);
    if (j.useMotor) {
      unit.configureMotorVelocity((j.motor?.targetVelocity ?? 0) * k, MOTOR_GAIN);
      unit.setMotorMaxForce(Math.max(j.motor?.force ?? 0, 0));
    } else if (j.useSpring) {
      unit.configureMotorPosition((j.spring?.targetPosition ?? 0) * k, j.spring?.spring ?? 0, j.spring?.damper ?? 0);
      unit.setMotorMaxForce(Number.MAX_VALUE);
    } else {
      unit.setMotorMaxForce(0); // off (configuring an idle motor instead would lock the axis)
    }
    st.body._state?.body.wakeUp();
  }

  /** @internal */
  releaseJoint(j: Joint): void {
    const st = j._state;
    if (!st) return;
    if (this.rapier.getImpulseJoint(st.joint.handle)) this.rapier.removeImpulseJoint(st.joint, true);
    if (st.ground) this.rapier.removeRigidBody(st.ground);
    j._state = null;
  }

  // --- character controllers (ADR 0091) -----------------------------------------------------------

  private readonly controllers = new Map<CharacterController, { kcc: RAPIER.KinematicCharacterController; settings: string }>();

  /** @internal Move a character controller by `motion`, sliding along what it hits; null before its collider exists. */
  moveCharacter(cc: CharacterController, motion: { x: number; y: number; z: number }): { movement: Vector3; flags: CollisionFlags; hits: ControllerColliderHit[] } | null {
    const st = cc._state;
    if (!st || !st.active || !cc.node.transform) return null;
    let entry = this.controllers.get(cc);
    if (!entry) this.controllers.set(cc, (entry = { kcc: this.rapier.createCharacterController(cc.skinWidth), settings: "" }));
    const kcc = entry.kcc;
    const settings = cc._settingsSignature();
    const radius = capsuleSize(cc.radius, cc.height, 1, this.worldScale(cc, cc.node.entity)).radius;
    if (entry.settings !== settings) {
      entry.settings = settings;
      kcc.setOffset(Math.max(cc.skinWidth, 1e-4));
      kcc.setSlideEnabled(true);
      kcc.setMaxSlopeClimbAngle(cc.slopeLimit * DEG2RAD);
      kcc.setMinSlopeSlideAngle(cc.slopeLimit * DEG2RAD);
      if (cc.stepOffset > 0) kcc.enableAutostep(cc.stepOffset, Math.max(radius * 0.5, 0.01), true);
      else kcc.disableAutostep();
      if (cc.snapToGround > 0) kcc.enableSnapToGround(cc.snapToGround);
      else kcc.disableSnapToGround();
      kcc.setApplyImpulsesToDynamicBodies(cc.pushBodies);
      kcc.setCharacterMass(Math.max(cc.mass, 1e-4));
    }
    // Start from where the node is now (a script may have moved it since the last push).
    const ws = this.worldScale(cc, cc.node.entity);
    const start = this.colliderWorldPose(cc, ws).p;
    const own = st.ownBody!;
    own.setTranslation(start, true);
    this.rapier.propagateModifiedBodyPositionsToColliders();
    kcc.computeColliderMovement(st.collider, { x: motion.x, y: motion.y, z: motion.z }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, this.groupsFor(cc.layer));
    const m = kcc.computedMovement();
    const movement = new Vector3(m.x, m.y, m.z);
    const end = start.clone().add(movement);
    own.setTranslation(end, true);
    this.rapier.propagateModifiedBodyPositionsToColliders();
    const t = cc.node.transform;
    const offset = scaledCenter([cc.center.x, cc.center.y, cc.center.z], ws);
    t.worldPosition = [end.x - offset[0], end.y - offset[1], end.z - offset[2]];
    st.syncedVersion = this.world.tVersion[cc.node.entity];

    const len = Math.hypot(motion.x, motion.y, motion.z);
    const dir = len > 0 ? new Vector3(motion.x / len, motion.y / len, motion.z / len) : new Vector3();
    const cosSlope = Math.cos(cc.slopeLimit * DEG2RAD);
    let below = kcc.computedGrounded(), sides = false, above = false;
    const hits: ControllerColliderHit[] = [];
    for (let i = 0, n = kcc.numComputedCollisions(); i < n; i++) {
      const hit = kcc.computedCollision(i);
      if (!hit?.collider) continue;
      const other = this.colliderByHandle.get(hit.collider.handle);
      if (!other || other._destroyed) continue;
      const nrm = hit.normal1, ny = nrm.y;
      if (ny >= cosSlope - 1e-3) below = true;
      else if (ny <= -cosSlope) above = true;
      else sides = true;
      const applied = hit.translationDeltaApplied;
      hits.push({
        controller: cc,
        collider: other,
        gameObject: other.owner,
        rigidbody: other._state?.body ?? null,
        point: new Vector3(hit.witness1.x, hit.witness1.y, hit.witness1.z),
        normal: new Vector3(nrm.x, nrm.y, nrm.z),
        moveDirection: dir,
        moveLength: Math.hypot(applied.x, applied.y, applied.z),
      });
    }
    return { movement, flags: { below, sides, above }, hits };
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
    for (const j of this.world._componentsOfType(Joint)) if (j._state && (j._state.body === rb || j._state.connected === rb)) this.releaseJoint(j);
    this.rapier.removeRigidBody(st.body);
    rb._state = null;
  }

  /** @internal */
  releaseCollider(c: Collider): void {
    const st = c._state;
    if (!st) return;
    const h = st.collider.handle;
    this.colliderByHandle.delete(h);
    if (c instanceof CharacterController) {
      const entry = this.controllers.get(c);
      if (entry) this.rapier.removeCharacterController(entry.kcc);
      this.controllers.delete(c);
    }
    for (const [key, pair] of this.touching) if (pair.h1 === h || pair.h2 === h) this.touching.delete(key);
    if (this.rapier.getCollider(h)) this.rapier.removeCollider(st.collider, true);
    if (st.ownBody) this.rapier.removeRigidBody(st.ownBody);
    c._state = null;
  }
}
