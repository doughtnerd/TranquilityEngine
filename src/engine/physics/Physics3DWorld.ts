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
import { Matrix4, Quaternion as ThreeQuaternion, Vector3 as ThreeVector3 } from "three";
import { GameBehavior } from "../core/Component";
import { DEG2RAD, Quaternion } from "../core/math";
import type { World } from "../core/World";
import { MeshRenderer } from "../render/components";
import { meshesIfLoaded, meshTriangles, type ModelMesh } from "../scene/models";
import { BoxCollider, CapsuleCollider, Collider, MeshCollider, SphereCollider, type Collision } from "./Collider";
import { layerGroups } from "./layers";
import { CollisionEvents, TriggerEvents } from "./physics3d";
import { RigidBody } from "./RigidBody";
import { AXIS_INDEX, boxHalfExtents, capsuleSize, scaledCenter, sphereRadius } from "./shape3d";

/** @internal */
export interface BodyHandleState3D {
  body: RAPIER.RigidBody;
  signature: string;
  syncedVersion: number;
  active: boolean;
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
}

let rapierReady: Promise<void> | null = null;

/** @internal Initialize Rapier 3D's WASM once. */
export function initRapier3D(): Promise<void> {
  return (rapierReady ??= RAPIER.init());
}

const m4 = new Matrix4();
const pos = new ThreeVector3();
const rot = new ThreeQuaternion();
const scl = new ThreeVector3();

/** A node's world position, rotation and (positive) scale. */
function worldPose(world: World, entity: number): { p: ThreeVector3; q: ThreeQuaternion; s: [number, number, number] } {
  m4.fromArray(world.worldMatrix(entity), entity * 16).decompose(pos, rot, scl);
  return { p: pos.clone(), q: rot.clone(), s: [Math.abs(scl.x), Math.abs(scl.y), Math.abs(scl.z)] };
}

/** Rapier capsules lie along Y: the turn that lays one along X or Z. */
const CAPSULE_TURN: Record<"x" | "y" | "z", ThreeQuaternion> = {
  x: new ThreeQuaternion().setFromAxisAngle(new ThreeVector3(0, 0, 1), -Math.PI / 2),
  y: new ThreeQuaternion(),
  z: new ThreeQuaternion().setFromAxisAngle(new ThreeVector3(1, 0, 0), Math.PI / 2),
};

/** @internal */
export class Physics3DWorld {
  readonly rapier: RAPIER.World;
  private readonly events = new RAPIER.EventQueue(true);
  private readonly colliderByHandle = new Map<number, Collider>();
  private readonly layerGroups: Map<string, number>;
  private readonly warned = new Set<string>();

  constructor(private readonly world: World) {
    const g = world.settings.physics.gravity as readonly number[];
    this.rapier = new RAPIER.World({ x: g[0] ?? 0, y: g[1] ?? -9.81, z: g[2] ?? 0 });
    this.layerGroups = layerGroups(world.settings.physics);
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
      }
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
    rb._force = [0, 0, 0];
    rb._torque = [0, 0, 0];
  }

  private createBody(rb: RigidBody): BodyHandleState3D {
    const { p, q } = rb.node.transform ? worldPose(this.world, rb.node.entity) : { p: new ThreeVector3(), q: new ThreeQuaternion() };
    const desc = rb.bodyType === "static" ? RAPIER.RigidBodyDesc.fixed() : rb.bodyType === "kinematic" ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic();
    desc.setTranslation(p.x, p.y, p.z).setRotation(q);
    const body = this.rapier.createRigidBody(desc);
    this.applyBodySettings(rb, body);
    return { body, signature: this.bodySignature(rb), syncedVersion: this.world.tVersion[rb.node.entity], active: true };
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
    const ws = c.node.transform ? worldPose(this.world, e).s : [1, 1, 1];
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
    if (!active || body) return;
    const version = this.world.tVersion[e];
    if (version !== st.syncedVersion) {
      const pose = this.colliderWorldPose(c, ws);
      st.collider.setTranslation(pose.p);
      st.collider.setRotation(pose.q);
      st.syncedVersion = version;
    }
  }

  /** World pose of the collider's shape: the node's pose plus its turned, scaled `center` (and a capsule's axis). */
  private colliderWorldPose(c: Collider, ws: readonly number[]): { p: ThreeVector3; q: ThreeQuaternion } {
    if (!c.node.transform) return { p: new ThreeVector3(c.center.x, c.center.y, c.center.z), q: new ThreeQuaternion() };
    const { p, q } = worldPose(this.world, c.node.entity);
    const offset = new ThreeVector3(...scaledCenter([c.center.x, c.center.y, c.center.z], ws)).applyQuaternion(q);
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
    const pose = this.colliderWorldPose(c, ws);
    if (body?._state) {
      // Placed relative to the body, in the body's turned frame.
      const b = body._state.body, bp = b.translation(), br = b.rotation();
      const inv = new ThreeQuaternion(br.x, br.y, br.z, br.w).invert();
      const rel = pose.p.clone().sub(new ThreeVector3(bp.x, bp.y, bp.z)).applyQuaternion(inv);
      desc.setTranslation(rel.x, rel.y, rel.z).setRotation(inv.multiply(pose.q)).setDensity(0);
    } else {
      desc.setTranslation(pose.p.x, pose.p.y, pose.p.z).setRotation(pose.q);
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
    return { collider, body, signature, syncedVersion: this.world.tVersion[c.node.entity], active: true, meshes };
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
      if (!st || !st.active || rb.bodyType !== "dynamic" || st.body.isSleeping()) continue;
      const t = rb.node.transform;
      if (!t) continue;
      const p = st.body.translation(), r = st.body.rotation();
      t._setWorldPose3D(p.x, p.y, p.z, new Quaternion(r.x, r.y, r.z, r.w));
      st.syncedVersion = this.world.tVersion[rb.node.entity];
    }
  }

  /** @internal */
  dispatchEvents(): void {
    this.events.drainCollisionEvents((h1, h2, started) => {
      const a = this.colliderByHandle.get(h1), b = this.colliderByHandle.get(h2);
      if (!a || !b || a._destroyed || b._destroyed) return;
      const trigger = a.isTrigger || b.isTrigger;
      this.world._buffer(trigger ? TriggerEvents : CollisionEvents).push({ a, b, started });
      this.notify(a, b, trigger, started);
      this.notify(b, a, trigger, started);
    });
  }

  /** Call the hook on active behaviors of `self`'s node, owner and body node. */
  private notify(self: Collider, other: Collider, trigger: boolean, started: boolean): void {
    const nodes = new Set([self.node.entity, self.owner.entity]);
    const body = self._state?.body;
    if (body?.node.isValid) nodes.add(body.node.entity);
    const hook = trigger ? (started ? "onTriggerEnter" : "onTriggerExit") : started ? "onCollisionEnter" : "onCollisionExit";
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
    this.colliderByHandle.delete(st.collider.handle);
    if (this.rapier.getCollider(st.collider.handle)) this.rapier.removeCollider(st.collider, true);
    c._state = null;
  }
}
