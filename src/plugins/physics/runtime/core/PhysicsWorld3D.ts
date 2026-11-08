/**
 * The shared sync core's 3D half (ADR 0045, 0137): what `PhysicsCore` needs to know about 3D poses,
 * shapes and joints. Internal: game code uses RigidBody, the 3D colliders and the Physics facade.
 */
import { DEG2RAD, Mat4, Quat, Quaternion, Vector3, type QuatLike } from "../../../../engine/core/math";
import type { World } from "../../../../engine/core/World";
import { AXIS_INDEX, boxHalfExtents, capsuleSize, scaledCenter, sphereRadius } from "../../../../engine/physics/shape3d";
import { MeshRenderer } from "../../../../engine/render/components";
import type { GameObject } from "../../../../engine/scene/GameObject";
import { meshesIfLoaded, meshTriangles, type ModelMesh } from "../../../../engine/scene/models";
import type { Transform } from "../../../../engine/scene/Transform";
import type { CharacterSettings, Dim3, JointDesc, JointSettings, PhysicsBackend3D, Pose, Quat as Q, ShapeDesc3D, Vec3 } from "../backend";
import { CharacterController, type ControllerColliderHit } from "../CharacterController";
import { BoxCollider, CapsuleCollider, Collider, MeshCollider, SphereCollider } from "../Collider";
import { AxisJoint, BallJoint, FixedJoint, HingeJoint, Joint, RopeJoint, SliderJoint, SpringJoint } from "../Joint";
import { RigidBody } from "../RigidBody";
import { CollisionEvents, TriggerEvents } from "../systems3d";
import { PhysicsCore } from "./PhysicsCore";

interface Types3D {
  body: RigidBody;
  collider: Collider;
  character: CharacterController;
  joint: Joint;
  hit: ControllerColliderHit;
  movement: Vector3;
}

type P3 = Pose<Dim3>;

const pos = [0, 0, 0];
const rot = [0, 0, 0, 1];
const scl = [1, 1, 1];

/** Capsules lie along Y: the turn that lays one along X or Z. */
const CAPSULE_TURN: Record<"x" | "y" | "z", Quaternion> = {
  x: Quat.fromAxisAngle(0, 0, 1, -Math.PI / 2),
  y: new Quaternion(),
  z: Quat.fromAxisAngle(1, 0, 0, Math.PI / 2),
};

/** A plain quaternion (backends read fields, not getters). */
const plain = (q: QuatLike): Q => ({ x: q.x, y: q.y, z: q.z, w: q.w });
const quat = (q: Q): Quaternion => new Quaternion(q.x, q.y, q.z, q.w);
const v3 = (v: { x: number; y: number; z: number }): Vec3 => ({ x: v.x, y: v.y, z: v.z });

/** The shortest turn taking the x axis onto unit vector `v`. */
function fromXTo(v: Vector3): Quaternion {
  const d = v.x;
  if (d < -0.999999) return new Quaternion(0, 1, 0, 0); // half a turn around y
  const q = new Quaternion(0, -v.z, v.y, 1 + d); // cross((1,0,0), v), 1 + dot
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  return new Quaternion(q.x / len, q.y / len, q.z / len, q.w / len);
}

/** @internal One World's 3D physics: the shared core over a 3D backend. */
export class PhysicsWorld3D extends PhysicsCore<Dim3, Types3D> {
  protected readonly Body = RigidBody;
  protected readonly Collider = Collider;
  protected readonly Character = CharacterController;
  protected readonly Joint = Joint;
  protected readonly triggerEvents = TriggerEvents;
  protected readonly collisionEvents = CollisionEvents;
  protected readonly bodyName = "RigidBody";
  protected readonly down = { x: 0, y: -1, z: 0 };
  protected readonly identity: Q = { x: 0, y: 0, z: 0, w: 1 };

  constructor(world: World, backend: PhysicsBackend3D) {
    const g = world.settings.physics.gravity as readonly number[];
    super(world, backend, { x: g[0] ?? 0, y: g[1] ?? -9.81, z: g[2] ?? 0 });
  }

  protected vec(a: readonly number[]): Vec3 {
    return { x: a[0], y: a[1], z: a[2] ?? 0 };
  }
  protected ang(a: readonly number[]): Vec3 {
    return { x: a[0], y: a[1], z: a[2] };
  }
  protected rotate(r: Q, v: readonly number[]): number[] {
    const p = Quat.rotate(quat(r), new Vector3(v[0], v[1], v[2]));
    return [p.x, p.y, p.z];
  }

  /** A node's world position, rotation and (positive) scale. */
  private worldPose(entity: number): { p: Vector3; q: Quaternion; s: [number, number, number] } {
    Mat4.decompose(this.world.worldMatrix(entity), entity * 16, pos, 0, rot, 0, scl, 0);
    return { p: new Vector3(pos[0], pos[1], pos[2]), q: new Quaternion(rot[0], rot[1], rot[2], rot[3]), s: [Math.abs(scl[0]), Math.abs(scl[1]), Math.abs(scl[2])] };
  }

  protected nodePose(node: GameObject): P3 {
    if (!node.transform) return { position: { x: 0, y: 0, z: 0 }, rotation: this.identity };
    const { p, q } = this.worldPose(node.entity);
    return { position: v3(p), rotation: plain(q) };
  }

  protected relativePose(parent: P3, child: P3): P3 {
    const inv = Quat.conjugate(quat(parent.rotation));
    const p = Quat.rotate(inv, new Vector3(child.position.x - parent.position.x, child.position.y - parent.position.y, child.position.z - parent.position.z));
    return { position: v3(p), rotation: plain(inv.multiply(quat(child.rotation))) };
  }

  protected writePose(t: Transform, pose: P3): void {
    t._setWorldPose3D(pose.position.x, pose.position.y, pose.position.z, quat(pose.rotation));
  }

  /** Normalized lerp, the short way round. */
  protected lerpRotation(a: Q, b: Q, t: number): Q {
    const s = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
    const x = a.x + (b.x * s - a.x) * t, y = a.y + (b.y * s - a.y) * t, z = a.z + (b.z * s - a.z) * t, w = a.w + (b.w * s - a.w) * t;
    const len = Math.hypot(x, y, z, w) || 1;
    return { x: x / len, y: y / len, z: z / len, w: w / len };
  }

  protected poseDiffers(a: P3, b: P3): boolean {
    const pa = a.position, pb = b.position, ra = a.rotation, rb = b.rotation;
    return [pa.x - pb.x, pa.y - pb.y, pa.z - pb.z, ra.x - rb.x, ra.y - rb.y, ra.z - rb.z, ra.w - rb.w].some((d) => Math.abs(d) > 1e-5);
  }

  protected bodySettings(rb: RigidBody) {
    const fp = rb.constraints?.freezePosition, fr = rb.constraints?.freezeRotation, mass = Math.max(rb.mass, 1e-4);
    return {
      type: rb.bodyType,
      mass,
      inertia: mass / 6, // box-ish: colliders on bodies have no density
      gravityScale: rb.useGravity ? rb.gravityScale : 0,
      linearDamping: rb.drag,
      angularDamping: rb.angularDrag,
      lockTranslation: [!!fp?.x, !!fp?.y, !!fp?.z],
      lockRotation: [!!fr?.x, !!fr?.y, !!fr?.z],
      ccd: rb.collisionDetection === "continuous",
    };
  }

  protected takePending(rb: RigidBody) {
    const velocity = rb._pendingVelocity ? [...rb._pendingVelocity] : null;
    const angularVelocity = rb._pendingAngularVelocity ? rb._pendingAngularVelocity.map((v) => v * DEG2RAD) : null;
    rb._pendingVelocity = null;
    rb._pendingAngularVelocity = null;
    const force = [...rb._force], torque = [...rb._torque];
    rb._force.fill(0);
    rb._torque.fill(0);
    return { velocity, angularVelocity, force, torque };
  }

  // --- colliders -----------------------------------------------------------------------------------

  /** Each collider's world scale and the transform version it was read at, so it's read only when the node moved. */
  private readonly scales = new WeakMap<Collider, { version: number; scale: [number, number, number] }>();

  private worldScale(c: Collider): readonly number[] {
    if (!c.node.transform) return [1, 1, 1];
    const e = c.node.entity;
    const version = this.world.tVersion[e];
    const cached = this.scales.get(c);
    if (cached && cached.version === version) return cached.scale;
    const scale = this.worldPose(e).s;
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

  protected colliderSource(c: Collider, active: boolean) {
    const ws = this.worldScale(c);
    const signature = [c._shapeSignature(), c.isTrigger, c.layer, c.material?.friction, c.material?.bounciness, ...ws.map((v) => v.toFixed(4)), c.center.x, c.center.y, c.center.z].join("|");
    const meshes = c instanceof MeshCollider && active ? this.colliderMeshes(c) : null;
    if (c instanceof MeshCollider && active && meshes === null) return null; // its model is loading
    return { signature, scale: ws, source: meshes };
  }

  protected colliderShape(c: Collider, ws: readonly number[], body: RigidBody | null, source: readonly unknown[] | null | undefined): ShapeDesc3D {
    if (c instanceof BoxCollider) {
      const [hx, hy, hz] = boxHalfExtents([c.size.x, c.size.y, c.size.z], ws);
      return { kind: "box", halfExtents: { x: Math.max(hx, 1e-4), y: Math.max(hy, 1e-4), z: Math.max(hz, 1e-4) } };
    }
    if (c instanceof SphereCollider) return { kind: "sphere", radius: Math.max(sphereRadius(c.radius, ws), 1e-4) };
    if (c instanceof CapsuleCollider || c instanceof CharacterController) {
      const axis = c instanceof CapsuleCollider ? (AXIS_INDEX[c.direction] ?? 1) : 1;
      const { radius, halfHeight } = capsuleSize(c.radius, c.height, axis, ws);
      return { kind: "capsule", halfHeight, radius: Math.max(radius, 1e-4) };
    }
    if (c instanceof MeshCollider) return this.meshShape(c, (source ?? []) as readonly ModelMesh[], ws, body);
    throw new Error(`Unsupported collider type ${c.constructor.name}.`);
  }

  /** A mesh collider's shape: the meshes' triangles, scaled with the node, exact or wrapped in their convex hull. */
  private meshShape(c: MeshCollider, meshes: readonly ModelMesh[], ws: readonly number[], body: RigidBody | null): ShapeDesc3D {
    const verts: number[] = [], tris: number[] = [];
    for (const m of meshes) {
      const { vertices, indices } = meshTriangles(m);
      const base = verts.length / 3;
      for (let i = 0; i < vertices.length; i += 3) verts.push(vertices[i] * ws[0], vertices[i + 1] * ws[1], vertices[i + 2] * ws[2]);
      for (const i of indices) tris.push(base + i);
    }
    if (verts.length < 9) {
      this.warnOnce(`empty:${c.node.entity}`, `${c.node.name}: MeshCollider's mesh has no triangles.`);
      return { kind: "sphere", radius: 1e-4 };
    }
    if (!c.convex && body && body.bodyType === "dynamic") {
      this.warnOnce(`concave:${c.node.entity}`, `${c.node.name}: a MeshCollider on a dynamic RigidBody should be convex; exact meshes only collide with other shapes.`);
    }
    if (!c.convex && !this.capabilities.meshColliders) this.warnOnce("meshes", "this physics backend has no triangle-mesh colliders; MeshColliders use their convex hull.");
    return { kind: "mesh", vertices: new Float32Array(verts), indices: new Uint32Array(tris), convex: c.convex || !this.capabilities.meshColliders, label: `${c.node.name}: MeshCollider` };
  }

  /** World pose of the collider's shape: the node's pose plus its turned, scaled `center` (and a capsule's axis). */
  protected colliderWorldPose(c: Collider, scale?: readonly number[]): P3 {
    if (!c.node.transform) return { position: { x: c.center.x, y: c.center.y, z: c.center.z }, rotation: this.identity };
    const ws = scale ?? this.worldScale(c);
    const { p, q } = this.worldPose(c.node.entity);
    const center = new Vector3(...scaledCenter([c.center.x, c.center.y, c.center.z], ws));
    // A character controller's capsule stays upright, whichever way its node turns.
    if (c instanceof CharacterController) return { position: v3(p.add(center)), rotation: this.identity };
    const offset = Quat.rotate(q, center);
    const turn = c instanceof CapsuleCollider ? (CAPSULE_TURN[c.direction] ?? CAPSULE_TURN.y) : null;
    return { position: v3(p.add(offset)), rotation: plain(turn ? q.clone().multiply(turn) : q) };
  }

  // --- joints --------------------------------------------------------------------------------------

  protected jointAnchorSignature(j: Joint): unknown[] {
    const a = j.anchor, ca = j.connectedAnchor;
    return [a.x, a.y, a.z, j.autoConfigureConnectedAnchor, ca.x, ca.y, ca.z];
  }

  /** A point in a node's local space, in world space. */
  private pointOf(node: GameObject, local: { x: number; y: number; z: number }): Vector3 {
    if (!node.transform) return new Vector3(local.x, local.y, local.z);
    const [x, y, z] = Mat4.transformPoint(this.world.worldMatrix(node.entity), node.entity * 16, local.x, local.y, local.z);
    return new Vector3(x, y, z);
  }

  protected jointDesc(j: Joint, pose1: P3, pose2: P3, connected: RigidBody | null) {
    const p1 = new Vector3(pose1.position.x, pose1.position.y, pose1.position.z), q1 = quat(pose1.rotation);
    const p2 = new Vector3(pose2.position.x, pose2.position.y, pose2.position.z), q2 = quat(pose2.rotation);
    const pw = this.pointOf(j.node, j.anchor);
    // The connected anchor: where the anchor is now, or `connectedAnchor`. Ropes and springs auto-anchor at the connected body's origin.
    const distanceJoint = j instanceof RopeJoint || j instanceof SpringJoint;
    let pw2: Vector3;
    if (!j.autoConfigureConnectedAnchor) pw2 = connected ? this.pointOf(j.connectedBody!, j.connectedAnchor) : new Vector3(j.connectedAnchor.x, j.connectedAnchor.y, j.connectedAnchor.z);
    else if (distanceJoint && connected) pw2 = p2.clone();
    else pw2 = pw.clone();
    const inv1 = Quat.conjugate(q1), inv2 = Quat.conjugate(q2);
    const a1 = Quat.rotate(inv1, pw.clone().sub(p1)), a2 = Quat.rotate(inv2, pw2.clone().sub(p2));
    // The joint's frame in world space: its x axis along the hinge or slider axis. Each body holds it in its own frame.
    const nodeQ = j.node.transform ? this.worldPose(j.node.entity).q : new Quaternion();
    const ax = j instanceof AxisJoint || j instanceof BallJoint ? j.axis : { x: 1, y: 0, z: 0 };
    const len = Math.hypot(ax.x, ax.y, ax.z) || 1;
    const frame = fromXTo(Quat.rotate(nodeQ, new Vector3(ax.x / len, ax.y / len, ax.z / len)));
    const f1 = plain(Quat.conjugate(q1).multiply(frame)), f2 = plain(Quat.conjugate(q2).multiply(frame));
    const dist = pw2.clone().sub(pw).length;
    const base = { anchor1: v3(a2), anchor2: v3(a1), frame1: f2, frame2: f1 };
    let desc: Omit<JointDesc<Dim3>, "body1" | "body2" | "contacts">;
    if (j instanceof FixedJoint) desc = { kind: "fixed", ...base };
    else if (j instanceof HingeJoint) desc = { kind: "revolute", ...base };
    else if (j instanceof SliderJoint) desc = { kind: "prismatic", ...base };
    else if (j instanceof BallJoint) desc = { kind: "spherical", ...base };
    else if (j instanceof RopeJoint) desc = { kind: "rope", anchor1: v3(a2), anchor2: v3(a1), length: j.autoConfigureDistance ? dist : Math.max(j.maxDistance, 0) };
    else if (j instanceof SpringJoint) desc = { kind: "spring", anchor1: v3(a2), anchor2: v3(a1), length: j.autoConfigureDistance ? dist : Math.max(j.restLength, 0), stiffness: j.spring, damping: j.damper };
    else throw new Error(`Unsupported joint type ${j.constructor.name}.`);
    if (j instanceof AxisJoint && j.useLimits) {
      const k = j instanceof HingeJoint ? DEG2RAD : 1;
      desc = { ...desc, limits: [Math.min(j.limits.min, j.limits.max) * k, Math.max(j.limits.min, j.limits.max) * k] };
    }
    return { desc, local1: v3(a1), local2: v3(a2), restAngle: 0 };
  }

  protected jointSettings(j: Joint): JointSettings | null {
    if (j instanceof BallJoint) {
      if (!j.useLimits) return null;
      const t = j.twistLimits ?? { min: 0, max: 0 };
      return { limits: null, motor: null, spring: null, cone: { twist: [Math.min(t.min, t.max) * DEG2RAD, Math.max(t.min, t.max) * DEG2RAD], swing: Math.abs(j.swingLimit) * DEG2RAD } };
    }
    if (!(j instanceof AxisJoint)) return null;
    const k = j instanceof HingeJoint ? DEG2RAD : 1;
    return {
      limits: j.useLimits ? [Math.min(j.limits.min, j.limits.max) * k, Math.max(j.limits.min, j.limits.max) * k] : null,
      motor: j.useMotor ? { targetVelocity: (j.motor?.targetVelocity ?? 0) * k, maxForce: Math.max(j.motor?.force ?? 0, 0) } : null,
      spring: !j.useMotor && j.useSpring ? { target: (j.spring?.targetPosition ?? 0) * k, stiffness: j.spring?.spring ?? 0, damping: j.spring?.damper ?? 0 } : null,
    };
  }

  // --- character controllers -----------------------------------------------------------------------

  protected characterSettings(cc: CharacterController): CharacterSettings {
    const radius = capsuleSize(cc.radius, cc.height, 1, this.worldScale(cc)).radius;
    return {
      offset: Math.max(cc.skinWidth, 1e-4),
      slopeLimit: cc.slopeLimit * DEG2RAD,
      autostep: cc.stepOffset > 0 ? { height: cc.stepOffset, minWidth: Math.max(radius * 0.5, 0.01) } : null,
      snapToGround: cc.snapToGround > 0 ? cc.snapToGround : null,
      pushBodies: cc.pushBodies,
      mass: Math.max(cc.mass, 1e-4),
    };
  }

  protected moveNode(cc: CharacterController, start: Vec3, m: Vec3): void {
    const offset = scaledCenter([cc.center.x, cc.center.y, cc.center.z], this.worldScale(cc));
    cc.node.transform!.worldPosition = [start.x + m.x - offset[0], start.y + m.y - offset[1], start.z + m.z - offset[2]];
  }

  protected carried(from: P3, to: P3, p: Vec3): Vec3 {
    // The point turns and moves with the body: t1 + r1 · r0⁻¹ · (p − t0).
    const turn = quat(to.rotation).multiply(Quat.conjugate(quat(from.rotation)));
    const moved = Quat.rotate(turn, new Vector3(p.x - from.position.x, p.y - from.position.y, p.z - from.position.z)).add(new Vector3(to.position.x, to.position.y, to.position.z));
    return { x: moved.x - p.x, y: moved.y - p.y, z: moved.z - p.z };
  }

  protected controllerHit(cc: CharacterController, other: Collider, point: Vec3, normal: Vec3, dir: number[], moveLength: number): ControllerColliderHit {
    return { controller: cc, collider: other, gameObject: other.owner, rigidbody: other._state?.body ?? null, point: new Vector3(point.x, point.y, point.z), normal: new Vector3(normal.x, normal.y, normal.z), moveDirection: new Vector3(dir[0], dir[1], dir[2]), moveLength };
  }

  protected movement(v: Vec3): Vector3 {
    return new Vector3(v.x, v.y, v.z);
  }
}
