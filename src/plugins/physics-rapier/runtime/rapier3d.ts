/**
 * The Rapier 3D physics backend (ADR 0005, 0045, 0137): Rapier calls and conversions only. The Physics
 * plugin's shared core decides what to create and when; this turns its neutral descriptions into Rapier
 * objects. Loaded on demand (with its WebAssembly) when a World first needs 3D physics.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import type {
  BackendBody,
  BackendRayInto,
  BackendCharacter,
  BackendCollider,
  BackendJoint,
  BodySettings,
  CharacterSettings,
  ColliderDesc,
  Dim3,
  JointDesc,
  JointSettings,
  PhysicsBackend3D,
  PhysicsWorld3DBackend,
  PhysicsWorldOptions,
  Pose,
  Quat,
  QueryShape3D,
  ShapeDesc3D,
  Vec3,
} from "../../physics/runtime";

type P3 = Pose<Dim3>;

/** How hard a joint motor drives towards its target velocity, before its `force` limit. */
const MOTOR_GAIN = 1e4;

let rapierReady: Promise<void> | null = null;

/** @internal Initialize Rapier 3D's WebAssembly once. */
export function initRapier3D(): Promise<void> {
  return (rapierReady ??= RAPIER.init().catch((err: unknown) => {
    rapierReady = null; // tried again next time
    throw err;
  }));
}

/** Plain objects: Rapier reads fields, not getters. */
const v3 = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const q4 = (q: Quat): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });

class Body implements BackendBody<Dim3> {
  removed = false;
  constructor(
    readonly rb: RAPIER.RigidBody,
    private readonly rapier: RAPIER.World,
  ) {}
  pose(): P3 {
    return { position: v3(this.rb.translation()), rotation: q4(this.rb.rotation()) };
  }
  teleport(p: P3): void {
    this.rb.setTranslation(v3(p.position), true);
    this.rb.setRotation(q4(p.rotation), true);
  }
  moveKinematic(p: P3): void {
    this.rb.setNextKinematicTranslation(v3(p.position));
    this.rb.setNextKinematicRotation(q4(p.rotation));
  }
  place(position: Vec3): void {
    this.rb.setTranslation(v3(position), true);
    this.rb.setNextKinematicTranslation(v3(position)); // or the step moves it back to a stale target
    this.rapier.propagateModifiedBodyPositionsToColliders();
  }
  configure(s: BodySettings): void {
    const rb = this.rb;
    const type = s.type === "static" ? RAPIER.RigidBodyType.Fixed : s.type === "kinematic" ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic;
    if (rb.bodyType() !== type) rb.setBodyType(type, true);
    rb.setGravityScale(s.gravityScale, true);
    rb.setLinearDamping(s.linearDamping);
    rb.setAngularDamping(s.angularDamping);
    const t = s.lockTranslation, r = s.lockRotation;
    rb.setEnabledTranslations(!t[0], !t[1], !t[2], true);
    rb.setEnabledRotations(!r[0], !r[1], !r[2], true);
    rb.enableCcd(s.ccd);
    rb.setAdditionalMassProperties(s.mass, { x: 0, y: 0, z: 0 }, { x: s.inertia, y: s.inertia, z: s.inertia }, { x: 0, y: 0, z: 0, w: 1 }, true);
  }
  setEnabled(on: boolean): void {
    this.rb.setEnabled(on);
  }
  isSleeping(): boolean {
    return this.rb.isSleeping();
  }
  isFixed(): boolean {
    return this.rb.isFixed();
  }
  wakeUp(): void {
    this.rb.wakeUp();
  }
  linearVelocity(): Vec3 {
    return v3(this.rb.linvel());
  }
  setLinearVelocity(v: Vec3): void {
    this.rb.setLinvel(v3(v), true);
  }
  angularVelocity(): Vec3 {
    return v3(this.rb.angvel());
  }
  setAngularVelocity(w: Vec3): void {
    this.rb.setAngvel(v3(w), true);
  }
  applyImpulse(i: Vec3): void {
    this.rb.applyImpulse(v3(i), true);
  }
  applyTorqueImpulse(t: Vec3): void {
    this.rb.applyTorqueImpulse(v3(t), true);
  }
  setStepForce(f: Vec3, t: Vec3): void {
    // Rapier's forces persist until reset.
    this.rb.resetForces(false);
    this.rb.resetTorques(false);
    if (f.x || f.y || f.z) this.rb.addForce(v3(f), true);
    if (t.x || t.y || t.z) this.rb.addTorque(v3(t), true);
  }
}

class Collider implements BackendCollider<Dim3> {
  constructor(readonly c: RAPIER.Collider) {}
  get id(): number {
    return this.c.handle;
  }
  setEnabled(on: boolean): void {
    this.c.setEnabled(on);
  }
  setLocalPose(p: P3): void {
    this.c.setTranslationWrtParent(v3(p.position));
    this.c.setRotationWrtParent(q4(p.rotation));
  }
  setPose(p: P3): void {
    this.c.setTranslation(v3(p.position));
    this.c.setRotation(q4(p.rotation));
  }
}

class Joint implements BackendJoint {
  constructor(readonly j: RAPIER.ImpulseJoint) {}
  configure(s: JointSettings): void {
    if (s.cone) {
      // Per-axis angular limits through the raw joint set (the JS class only exposes them on hinges and sliders).
      const raw = (this.j as unknown as { rawSet: { jointSetLimits(h: number, axis: number, min: number, max: number): void } }).rawSet;
      raw.jointSetLimits(this.j.handle, RAPIER.JointAxis.AngX, s.cone.twist[0], s.cone.twist[1]);
      raw.jointSetLimits(this.j.handle, RAPIER.JointAxis.AngY, -s.cone.swing, s.cone.swing);
      raw.jointSetLimits(this.j.handle, RAPIER.JointAxis.AngZ, -s.cone.swing, s.cone.swing);
      return;
    }
    const unit = this.j as RAPIER.UnitImpulseJoint;
    if (!unit.setLimits) return;
    if (s.limits) unit.setLimits(s.limits[0], s.limits[1]);
    if (s.motor || s.spring) unit.configureMotorModel(RAPIER.MotorModel.ForceBased);
    if (s.motor) {
      unit.configureMotorVelocity(s.motor.targetVelocity, MOTOR_GAIN);
      unit.setMotorMaxForce(s.motor.maxForce);
    } else if (s.spring) {
      unit.configureMotorPosition(s.spring.target, s.spring.stiffness, s.spring.damping);
      unit.setMotorMaxForce(Number.MAX_VALUE);
    } else {
      unit.setMotorMaxForce(0); // off (configuring an idle motor instead would lock the axis)
    }
  }
}

class Character implements BackendCharacter<Dim3> {
  private push = false;
  constructor(
    readonly kcc: RAPIER.KinematicCharacterController,
    private readonly rapier: RAPIER.World,
  ) {}
  configure(s: CharacterSettings): void {
    const kcc = this.kcc;
    kcc.setOffset(s.offset);
    kcc.setSlideEnabled(true);
    kcc.setMaxSlopeClimbAngle(s.slopeLimit);
    kcc.setMinSlopeSlideAngle(s.slopeLimit);
    if (s.autostep) kcc.enableAutostep(s.autostep.height, s.autostep.minWidth, true);
    else kcc.disableAutostep();
    if (s.snapToGround !== null) kcc.enableSnapToGround(s.snapToGround);
    else kcc.disableSnapToGround();
    kcc.setApplyImpulsesToDynamicBodies(s.pushBodies);
    kcc.setCharacterMass(s.mass);
    this.push = s.pushBodies;
  }
  move(collider: BackendCollider<Dim3>, motion: Vec3, groups: number) {
    const kcc = this.kcc, col = (collider as Collider).c;
    // Rapier's controller adds the ground body's motion over one timestep on every call (frame-rate
    // dependent, and only while moving); the core carries characters on platforms instead. Pushing
    // bodies scales its impulses by that timestep, so it runs as a second pass at the real one.
    const filter = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    if (this.push) kcc.computeColliderMovement(col, v3(motion), filter, groups); // applies the impulses; its movement isn't used
    const dt = this.rapier.timestep;
    kcc.setApplyImpulsesToDynamicBodies(false);
    this.rapier.timestep = 1e-6;
    kcc.computeColliderMovement(col, v3(motion), filter, groups);
    this.rapier.timestep = dt;
    kcc.setApplyImpulsesToDynamicBodies(this.push);
    const hits = [];
    for (let i = 0, n = kcc.numComputedCollisions(); i < n; i++) {
      const hit = kcc.computedCollision(i);
      if (!hit?.collider) continue;
      hits.push({ collider: hit.collider.handle, point: v3(hit.witness1), normal: v3(hit.normal1), applied: v3(hit.translationDeltaApplied) });
    }
    return { movement: v3(kcc.computedMovement()), grounded: kcc.computedGrounded(), hits };
  }
}

/** @internal One World's Rapier 3D simulation. */
export class RapierWorld3D implements PhysicsWorld3DBackend {
  readonly rapier: RAPIER.World;
  private readonly events = new RAPIER.EventQueue(true);
  private readonly bodies = new Map<number, Body>();
  // `raycastInto`'s reused state: the ray, and the predicate (made once, it reads `rayAccept`).
  private readonly queryRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  private rayAccept: (collider: number) => boolean = () => true;
  private readonly rayPredicate = (c: RAPIER.Collider): boolean => this.rayAccept(c.handle);

  constructor(private readonly options: PhysicsWorldOptions<Dim3>) {
    this.rapier = new RAPIER.World(v3(options.gravity));
  }

  get gravity(): Vec3 {
    return v3(this.rapier.gravity);
  }
  set gravity(g: Vec3) {
    this.rapier.gravity = v3(g);
  }

  step(dt: number): void {
    this.rapier.timestep = dt;
    this.rapier.step(this.events);
  }

  free(): void {
    this.rapier.free();
  }

  createBody(type: BodySettings["type"], pose: P3, settings: BodySettings | null): Body {
    const desc = type === "static" ? RAPIER.RigidBodyDesc.fixed() : type === "kinematic" ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic();
    desc.setTranslation(pose.position.x, pose.position.y, pose.position.z).setRotation(q4(pose.rotation));
    const body = new Body(this.rapier.createRigidBody(desc), this.rapier);
    if (settings) body.configure(settings);
    this.bodies.set(body.rb.handle, body);
    return body;
  }

  removeBody(b: BackendBody<Dim3>): void {
    const body = b as Body;
    if (body.removed) return;
    body.removed = true;
    this.bodies.delete(body.rb.handle);
    if (this.rapier.getRigidBody(body.rb.handle)) this.rapier.removeRigidBody(body.rb);
  }

  private shape(s: ShapeDesc3D): RAPIER.ColliderDesc {
    switch (s.kind) {
      case "box":
        return RAPIER.ColliderDesc.cuboid(s.halfExtents.x, s.halfExtents.y, s.halfExtents.z);
      case "sphere":
        return RAPIER.ColliderDesc.ball(s.radius);
      case "capsule":
        return RAPIER.ColliderDesc.capsule(s.halfHeight, s.radius);
      case "mesh": {
        if (s.convex) {
          const hull = RAPIER.ColliderDesc.convexHull(s.vertices);
          if (hull) return hull;
          this.options.warn(`hull:${s.label ?? ""}`, `${s.label ?? "A mesh collider"}'s mesh has no convex hull (it's flat); colliding with its triangles.`);
        }
        return RAPIER.ColliderDesc.trimesh(s.vertices, s.indices);
      }
    }
  }

  createCollider(d: ColliderDesc<Dim3>): BackendCollider<Dim3> {
    const desc = this.shape(d.shape);
    desc.setTranslation(d.pose.position.x, d.pose.position.y, d.pose.position.z).setRotation(q4(d.pose.rotation));
    // Colliders on bodies have zero density; the body's mass comes from its settings.
    if (d.parent) desc.setDensity(0);
    desc
      .setSensor(d.sensor)
      .setFriction(d.friction)
      .setRestitution(d.restitution)
      .setCollisionGroups(d.groups)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      // Every body pairs with a character controller's kinematic body except other kinematic ones: their
      // contacts would let Rapier's controller drag it along with platforms on some steps.
      .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED);
    return new Collider(this.rapier.createCollider(desc, (d.parent as Body | null)?.rb));
  }

  removeCollider(c: BackendCollider<Dim3>): void {
    const live = this.rapier.getCollider((c as Collider).c.handle);
    if (live) this.rapier.removeCollider(live, true);
  }

  createJoint(d: JointDesc<Dim3>): BackendJoint {
    const a1 = v3(d.anchor1), a2 = v3(d.anchor2), f1 = q4(d.frame1 ?? { x: 0, y: 0, z: 0, w: 1 }), f2 = q4(d.frame2 ?? { x: 0, y: 0, z: 0, w: 1 });
    let data: RAPIER.JointData;
    switch (d.kind) {
      case "fixed":
        data = RAPIER.JointData.fixed(a1, f1, a2, f2);
        break;
      case "revolute":
        data = RAPIER.JointData.revolute(a1, a2, { x: 1, y: 0, z: 0 });
        break;
      case "prismatic":
        data = RAPIER.JointData.prismatic(a1, a2, { x: 1, y: 0, z: 0 });
        break;
      case "spherical":
        data = RAPIER.JointData.spherical(a1, a2);
        break;
      case "rope":
        data = RAPIER.JointData.rope(d.length ?? 0, a1, a2);
        break;
      case "spring":
        data = RAPIER.JointData.spring(d.length ?? 0, d.stiffness ?? 0, d.damping ?? 0, a1, a2);
        break;
    }
    if (d.limits) {
      data.limitsEnabled = true;
      data.limits = [d.limits[0], d.limits[1]];
    }
    const joint = this.rapier.createImpulseJoint(data, (d.body1 as Body).rb, (d.body2 as Body).rb, true);
    // Hinges, sliders and ball joints turn about the joint's frame: its x axis is the hinge or slider axis.
    if (d.kind === "revolute" || d.kind === "prismatic" || d.kind === "spherical") {
      joint.setLocalFrame1(a1, f1);
      joint.setLocalFrame2(a2, f2);
    }
    joint.setContactsEnabled(d.contacts);
    return new Joint(joint);
  }

  removeJoint(j: BackendJoint): void {
    const joint = (j as Joint).j;
    if (this.rapier.getImpulseJoint(joint.handle)) this.rapier.removeImpulseJoint(joint, true);
  }

  createCharacter(): BackendCharacter<Dim3> {
    return new Character(this.rapier.createCharacterController(0.02), this.rapier);
  }

  removeCharacter(c: BackendCharacter<Dim3>): void {
    this.rapier.removeCharacterController((c as Character).kcc);
  }

  drainCollisionEvents(fn: (c1: number, c2: number, started: boolean) => void): void {
    this.events.drainCollisionEvents(fn);
  }

  contactImpulses(c: BackendCollider<Dim3>) {
    const col = (c as Collider).c;
    const out: { impulse: Vec3; point: Vec3 | null }[] = [];
    this.rapier.contactPairsWith(col, (other) => {
      this.rapier.contactPair(col, other, (manifold, flipped) => {
        const n = manifold.normal(), sign = flipped ? 1 : -1;
        for (let i = 0; i < manifold.numContacts(); i++) {
          const k = manifold.contactImpulse(i) * sign;
          if (!k) continue;
          const p = i < manifold.numSolverContacts() ? manifold.solverContactPoint(i) : null;
          out.push({ impulse: { x: n.x * k, y: n.y * k, z: n.z * k }, point: p ? v3(p) : null });
        }
      });
    });
    return out;
  }

  private queryShape(s: QueryShape3D): RAPIER.Shape {
    switch (s.kind) {
      case "sphere":
        return new RAPIER.Ball(s.radius);
      case "box":
        return new RAPIER.Cuboid(s.halfExtents.x, s.halfExtents.y, s.halfExtents.z);
      case "capsule":
        return new RAPIER.Capsule(s.halfHeight, s.radius);
    }
  }

  raycast(origin: Vec3, direction: Vec3, maxDistance: number, groups?: number) {
    const ray = new RAPIER.Ray(v3(origin), v3(direction));
    const hit = this.rapier.castRayAndGetNormal(ray, maxDistance, true, undefined, groups);
    if (!hit) return null;
    return { collider: hit.collider.handle, point: v3(ray.pointAt(hit.timeOfImpact)), normal: v3(hit.normal), distance: hit.timeOfImpact };
  }

  raycastInto(origin: Vec3, direction: Vec3, maxDistance: number, groups: number | undefined, excludeSensors: boolean, accept: (collider: number) => boolean, out: BackendRayInto): boolean {
    const ray = this.queryRay;
    ray.origin.x = origin.x;
    ray.origin.y = origin.y;
    ray.origin.z = origin.z;
    ray.dir.x = direction.x;
    ray.dir.y = direction.y;
    ray.dir.z = direction.z;
    this.rayAccept = accept;
    // The predicate runs inside Rapier's traversal, so a rejected collider doesn't hide the one behind it.
    const hit = this.rapier.castRay(ray, maxDistance, true, excludeSensors ? RAPIER.QueryFilterFlags.EXCLUDE_SENSORS : undefined, groups, undefined, undefined, this.rayPredicate);
    if (!hit) return false;
    const t = hit.timeOfImpact;
    out.collider = hit.collider.handle;
    out.distance = t;
    out.point.x = origin.x + direction.x * t;
    out.point.y = origin.y + direction.y * t;
    out.point.z = origin.z + direction.z * t;
    return true;
  }

  castShape(shape: QueryShape3D, position: Vec3, rotation: Quat, direction: Vec3, maxDistance: number, groups?: number) {
    const hit = this.rapier.castShape(v3(position), q4(rotation), v3(direction), this.queryShape(shape), 0, maxDistance, true, undefined, groups);
    if (!hit) return null;
    // World.castShape reports witness1/normal1 on the hit collider in world space.
    return { collider: hit.collider.handle, point: v3(hit.witness1), normal: v3(hit.normal1), distance: hit.time_of_impact };
  }

  castCollider(c: BackendCollider<Dim3>, direction: Vec3, maxDistance: number, groups: number, exclude: BackendBody<Dim3> | null) {
    const col = (c as Collider).c;
    const hit = this.rapier.castShape(col.translation(), col.rotation(), v3(direction), col.shape, 0, maxDistance, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups, col, (exclude as Body | null)?.rb);
    if (!hit) return null;
    const parent = hit.collider.parent();
    return { collider: hit.collider.handle, body: parent ? (this.bodies.get(parent.handle) ?? null) : null };
  }

  overlap(shape: QueryShape3D, position: Vec3, rotation: Quat, groups?: number): number[] {
    const found: number[] = [];
    this.rapier.intersectionsWithShape(v3(position), q4(rotation), this.queryShape(shape), (c) => (found.push(c.handle), true), undefined, groups);
    return found;
  }

  overlapPoint(point: Vec3, groups?: number): number[] {
    const found: number[] = [];
    this.rapier.intersectionsWithPoint(v3(point), (c) => (found.push(c.handle), true), undefined, groups);
    return found;
  }
}

/** The Rapier 3D backend (ADR 0137). */
export const rapier3DBackend: PhysicsBackend3D = {
  capabilities: { characterController: true, jointMotors: true, continuousCollision: true, oneWayPlatforms: false, meshColliders: true },
  createWorld: (options) => new RapierWorld3D(options),
};
