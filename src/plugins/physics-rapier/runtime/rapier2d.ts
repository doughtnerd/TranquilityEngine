/**
 * The Rapier 2D physics backend (ADR 0005, 0137): Rapier calls and conversions only. The Physics plugin's
 * shared core decides what to create and when; this turns its neutral descriptions into Rapier objects.
 * Loaded on demand (with its WebAssembly) when a World first needs 2D physics.
 */
import RAPIER from "@dimforge/rapier2d-compat";
import type {
  BackendBody,
  BackendCharacter,
  BackendCollider,
  BackendJoint,
  BodySettings,
  CharacterSettings,
  ColliderDesc,
  Dim2,
  JointDesc,
  JointSettings,
  PhysicsBackend2D,
  PhysicsWorld2DBackend,
  PhysicsWorldOptions,
  Point2,
  Pose,
  QueryShape2D,
  ShapeDesc2D,
  Vec2,
} from "../../physics/runtime";

type P2 = Pose<Dim2>;

/** How hard a joint motor drives towards its target velocity, before its `force` limit. */
const MOTOR_GAIN = 1e4;

let rapierReady: Promise<void> | null = null;

/** @internal Initialize Rapier 2D's WebAssembly once. */
export function initRapier2D(): Promise<void> {
  return (rapierReady ??= RAPIER.init().catch((err: unknown) => {
    rapierReady = null; // tried again next time
    throw err;
  }));
}

const flat = (pts: readonly Point2[]) => new Float32Array(pts.flatMap((p) => [p[0], p[1]]));
const v2 = (v: Vec2): Vec2 => ({ x: v.x, y: v.y });

class Body implements BackendBody<Dim2> {
  removed = false;
  constructor(
    readonly rb: RAPIER.RigidBody,
    private readonly rapier: RAPIER.World,
  ) {}
  pose(): P2 {
    const t = this.rb.translation();
    return { position: { x: t.x, y: t.y }, rotation: this.rb.rotation() };
  }
  teleport(p: P2): void {
    this.rb.setTranslation(v2(p.position), true);
    this.rb.setRotation(p.rotation, true);
  }
  moveKinematic(p: P2): void {
    this.rb.setNextKinematicTranslation(v2(p.position));
    this.rb.setNextKinematicRotation(p.rotation);
  }
  place(position: Vec2): void {
    this.rb.setTranslation(v2(position), true);
    this.rb.setNextKinematicTranslation(v2(position)); // or the step moves it back to a stale target
    this.rapier.propagateModifiedBodyPositionsToColliders();
  }
  configure(s: BodySettings): void {
    const rb = this.rb;
    const type = s.type === "static" ? RAPIER.RigidBodyType.Fixed : s.type === "kinematic" ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic;
    if (rb.bodyType() !== type) rb.setBodyType(type, true);
    rb.setGravityScale(s.gravityScale, true);
    rb.setLinearDamping(s.linearDamping);
    rb.setAngularDamping(s.angularDamping);
    rb.setEnabledTranslations(!s.lockTranslation[0], !s.lockTranslation[1], true);
    rb.lockRotations(!!s.lockRotation[0], true);
    rb.enableCcd(s.ccd);
    rb.setAdditionalMassProperties(s.mass, { x: 0, y: 0 }, s.inertia, true);
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
  linearVelocity(): Vec2 {
    return v2(this.rb.linvel());
  }
  setLinearVelocity(v: Vec2): void {
    this.rb.setLinvel(v2(v), true);
  }
  angularVelocity(): number {
    return this.rb.angvel();
  }
  setAngularVelocity(w: number): void {
    this.rb.setAngvel(w, true);
  }
  applyImpulse(i: Vec2): void {
    this.rb.applyImpulse(v2(i), true);
  }
  applyTorqueImpulse(t: number): void {
    this.rb.applyTorqueImpulse(t, true);
  }
  setStepForce(f: Vec2, t: number): void {
    // Rapier's forces persist until reset.
    this.rb.resetForces(false);
    this.rb.resetTorques(false);
    if (f.x || f.y) this.rb.addForce(v2(f), true);
    if (t) this.rb.addTorque(t, true);
  }
}

class Collider implements BackendCollider<Dim2> {
  constructor(readonly c: RAPIER.Collider) {}
  get id(): number {
    return this.c.handle;
  }
  setEnabled(on: boolean): void {
    this.c.setEnabled(on);
  }
  setLocalPose(p: P2): void {
    this.c.setTranslationWrtParent(v2(p.position));
    this.c.setRotationWrtParent(p.rotation);
  }
  setPose(p: P2): void {
    this.c.setTranslation(v2(p.position));
    this.c.setRotation(p.rotation);
  }
}

class Joint implements BackendJoint {
  constructor(readonly j: RAPIER.ImpulseJoint) {}
  configure(s: JointSettings): void {
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

class Character implements BackendCharacter<Dim2> {
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
  move(collider: BackendCollider<Dim2>, motion: Vec2, groups: number) {
    const kcc = this.kcc, col = (collider as Collider).c;
    // Rapier's controller adds the ground body's motion over one timestep on every call (frame-rate
    // dependent, and only while moving); the core carries characters on platforms instead. Pushing
    // bodies scales its impulses by that timestep, so it runs as a second pass at the real one.
    const filter = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    if (this.push) kcc.computeColliderMovement(col, v2(motion), filter, groups); // applies the impulses; its movement isn't used
    const dt = this.rapier.timestep;
    kcc.setApplyImpulsesToDynamicBodies(false);
    this.rapier.timestep = 1e-6;
    kcc.computeColliderMovement(col, v2(motion), filter, groups);
    this.rapier.timestep = dt;
    kcc.setApplyImpulsesToDynamicBodies(this.push);
    const hits = [];
    for (let i = 0, n = kcc.numComputedCollisions(); i < n; i++) {
      const hit = kcc.computedCollision(i);
      if (!hit?.collider) continue;
      hits.push({ collider: hit.collider.handle, point: v2(hit.witness1), normal: v2(hit.normal1), applied: v2(hit.translationDeltaApplied) });
    }
    return { movement: v2(kcc.computedMovement()), grounded: kcc.computedGrounded(), hits };
  }
}

interface OneWay {
  /** The platform's up direction in world space and its top along it when built. */
  upX: number;
  upY: number;
  top: number;
  /** The collider's own position along up when built (a platform on a moving body moves its top with it). */
  base: number;
}

/** One-way platforms (ADR 0105): a contact-pair hook lets bodies through from below. */
class OneWayPlatforms {
  /** One-way colliders by handle. */
  readonly byHandle = new Map<number, OneWay>();
  private dt = 1 / 60;
  /** Bodies' colliders as they were before the step: Rapier's world can't be read from inside a hook. */
  private readonly snapshot = new Map<number, { x: number; y: number; hx: number; hy: number; vx: number; vy: number }>();
  readonly hooks: RAPIER.PhysicsHooks = {
    filterContactPair: (c1, c2) => this.filter(c1, c2),
    filterIntersectionPair: () => true,
  };

  constructor(private readonly rapier: RAPIER.World) {}

  /** Before each step: note the timestep and, with one-way platforms about, every moving collider's pose and velocity. */
  beforeStep(dt: number): void {
    this.dt = dt;
    this.snapshot.clear();
    if (!this.byHandle.size) return;
    this.rapier.forEachCollider((col) => {
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
  private filter(c1: number, c2: number): RAPIER.SolverFlags | null {
    let platformHandle = c1, other = c2;
    let platform = this.byHandle.get(c1);
    if (!platform) {
      platform = this.byHandle.get(c2);
      platformHandle = c2;
      other = c1;
    }
    if (!platform || this.byHandle.has(other)) return RAPIER.SolverFlags.COMPUTE_IMPULSE;
    const o = this.snapshot.get(other);
    if (!o) return RAPIER.SolverFlags.COMPUTE_IMPULSE; // a static collider
    const { upX, upY } = platform;
    const bottom = o.x * upX + o.y * upY - (Math.abs(o.hx * upX) + Math.abs(o.hy * upY));
    let rel = o.vx * upX + o.vy * upY;
    const pv = this.snapshot.get(platformHandle); // a platform on a moving body
    let top = platform.top;
    if (pv) {
      rel -= pv.vx * upX + pv.vy * upY;
      top += pv.x * upX + pv.y * upY - platform.base;
    }
    const tolerance = 0.02 + Math.abs(rel) * this.dt;
    return rel > 0.01 || bottom < top - tolerance ? RAPIER.SolverFlags.EMPTY : RAPIER.SolverFlags.COMPUTE_IMPULSE;
  }
}

/** @internal One World's Rapier 2D simulation. */
export class RapierWorld2D implements PhysicsWorld2DBackend {
  readonly rapier: RAPIER.World;
  private readonly events = new RAPIER.EventQueue(true);
  private readonly bodies = new Map<number, Body>();
  private readonly oneWay: OneWayPlatforms;

  constructor(options: PhysicsWorldOptions<Dim2>) {
    this.rapier = new RAPIER.World(v2(options.gravity));
    this.oneWay = new OneWayPlatforms(this.rapier);
  }

  get gravity(): Vec2 {
    return v2(this.rapier.gravity);
  }
  set gravity(g: Vec2) {
    this.rapier.gravity = v2(g);
  }

  step(dt: number): void {
    this.rapier.timestep = dt;
    this.oneWay.beforeStep(dt);
    this.rapier.step(this.events, this.oneWay.byHandle.size ? this.oneWay.hooks : undefined);
  }

  free(): void {
    this.rapier.free();
  }

  createBody(type: BodySettings["type"], pose: P2, settings: BodySettings | null): Body {
    const desc = type === "static" ? RAPIER.RigidBodyDesc.fixed() : type === "kinematic" ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic();
    desc.setTranslation(pose.position.x, pose.position.y).setRotation(pose.rotation);
    const body = new Body(this.rapier.createRigidBody(desc), this.rapier);
    if (settings) body.configure(settings);
    this.bodies.set(body.rb.handle, body);
    return body;
  }

  removeBody(b: BackendBody<Dim2>): void {
    const body = b as Body;
    if (body.removed) return;
    body.removed = true;
    this.bodies.delete(body.rb.handle);
    if (this.rapier.getRigidBody(body.rb.handle)) this.rapier.removeRigidBody(body.rb);
  }

  private shape(s: ShapeDesc2D): RAPIER.ColliderDesc {
    switch (s.kind) {
      case "box":
        return RAPIER.ColliderDesc.cuboid(s.halfExtents.x, s.halfExtents.y);
      case "circle":
        return RAPIER.ColliderDesc.ball(s.radius);
      case "capsule":
        return RAPIER.ColliderDesc.capsule(s.halfHeight, s.radius);
      case "convexPolygons": {
        if (s.parts.length === 1) {
          const hull = RAPIER.ColliderDesc.convexHull(flat(s.parts[0]));
          if (hull) return hull;
          console.warn(`[myco] ${s.label ?? "A polygon collider"}: points don't make a simple polygon; colliding along its outline.`);
          return RAPIER.ColliderDesc.polyline(flat([...s.outline, s.outline[0]]));
        }
        const shapes = s.parts.map((p) => new RAPIER.ConvexPolygon(flat(p), true));
        return RAPIER.ColliderDesc.compound(shapes, shapes.map(() => ({ x: 0, y: 0 })), shapes.map(() => 0));
      }
      case "convexHull":
        return RAPIER.ColliderDesc.convexHull(flat(s.points)) ?? RAPIER.ColliderDesc.ball(1e-4);
      case "polyline":
        return s.oriented ? RAPIER.ColliderDesc.polyline(flat(s.points), null, RAPIER.PolylineFlags.ORIENTED) : RAPIER.ColliderDesc.polyline(flat(s.points));
      case "compound": {
        const shapes = s.parts.map((p) => this.partShape(p.shape));
        const positions = s.parts.map((p) => v2(p.offset)), rotations = s.parts.map(() => 0);
        return s.fixInternalEdges ? RAPIER.ColliderDesc.compound(shapes, positions, rotations, RAPIER.CompoundFlags.FIX_INTERNAL_EDGES) : RAPIER.ColliderDesc.compound(shapes, positions, rotations);
      }
    }
  }

  /** A compound's part. */
  private partShape(s: ShapeDesc2D): RAPIER.Shape {
    switch (s.kind) {
      case "box":
        return new RAPIER.Cuboid(s.halfExtents.x, s.halfExtents.y);
      case "circle":
        return new RAPIER.Ball(s.radius);
      case "convexHull":
        return new RAPIER.ConvexPolygon(flat(s.points), false);
      default:
        throw new Error(`A compound collider can't hold a ${s.kind} part.`);
    }
  }

  createCollider(d: ColliderDesc<Dim2>): BackendCollider<Dim2> {
    const desc = this.shape(d.shape);
    desc.setTranslation(d.pose.position.x, d.pose.position.y).setRotation(d.pose.rotation);
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
    if (d.oneWay) desc.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS);
    const collider = this.rapier.createCollider(desc, (d.parent as Body | null)?.rb);
    if (d.oneWay) this.oneWay.byHandle.set(collider.handle, { upX: d.oneWay.up.x, upY: d.oneWay.up.y, top: d.oneWay.top, base: d.oneWay.base });
    return new Collider(collider);
  }

  removeCollider(c: BackendCollider<Dim2>): void {
    const col = (c as Collider).c, h = col.handle;
    this.oneWay.byHandle.delete(h);
    const live = this.rapier.getCollider(h);
    if (live) this.rapier.removeCollider(live, true);
  }

  createJoint(d: JointDesc<Dim2>): BackendJoint {
    let data: RAPIER.JointData;
    switch (d.kind) {
      case "fixed":
        data = RAPIER.JointData.fixed(v2(d.anchor1), d.frame1 ?? 0, v2(d.anchor2), d.frame2 ?? 0);
        break;
      case "revolute":
        data = RAPIER.JointData.revolute(v2(d.anchor1), v2(d.anchor2));
        break;
      case "prismatic":
        data = RAPIER.JointData.prismatic(v2(d.anchor1), v2(d.anchor2), v2(d.axis ?? { x: 1, y: 0 }));
        break;
      case "rope":
        data = RAPIER.JointData.rope(d.length ?? 0, v2(d.anchor1), v2(d.anchor2));
        break;
      case "spring":
        data = RAPIER.JointData.spring(d.length ?? 0, d.stiffness ?? 0, d.damping ?? 0, v2(d.anchor1), v2(d.anchor2));
        break;
    }
    if (d.limits) {
      data.limitsEnabled = true;
      data.limits = [d.limits[0], d.limits[1]];
    }
    const joint = this.rapier.createImpulseJoint(data, (d.body1 as Body).rb, (d.body2 as Body).rb, true);
    joint.setContactsEnabled(d.contacts);
    return new Joint(joint);
  }

  removeJoint(j: BackendJoint): void {
    const joint = (j as Joint).j;
    if (this.rapier.getImpulseJoint(joint.handle)) this.rapier.removeImpulseJoint(joint, true);
  }

  createCharacter(): BackendCharacter<Dim2> {
    return new Character(this.rapier.createCharacterController(0.02), this.rapier);
  }

  removeCharacter(c: BackendCharacter<Dim2>): void {
    this.rapier.removeCharacterController((c as Character).kcc);
  }

  drainCollisionEvents(fn: (c1: number, c2: number, started: boolean) => void): void {
    this.events.drainCollisionEvents(fn);
  }

  contactImpulses(c: BackendCollider<Dim2>) {
    const col = (c as Collider).c;
    const out: { impulse: Vec2; point: Vec2 | null }[] = [];
    this.rapier.contactPairsWith(col, (other) => {
      this.rapier.contactPair(col, other, (manifold, flipped) => {
        const n = manifold.normal(), sign = flipped ? 1 : -1;
        for (let i = 0; i < manifold.numContacts(); i++) {
          const k = manifold.contactImpulse(i) * sign;
          if (!k) continue;
          const p = i < manifold.numSolverContacts() ? manifold.solverContactPoint(i) : null;
          out.push({ impulse: { x: n.x * k, y: n.y * k }, point: p ? v2(p) : null });
        }
      });
    });
    return out;
  }

  private queryShape(s: QueryShape2D): RAPIER.Shape {
    switch (s.kind) {
      case "circle":
        return new RAPIER.Ball(s.radius);
      case "box":
        return new RAPIER.Cuboid(s.halfExtents.x, s.halfExtents.y);
      case "capsule":
        return new RAPIER.Capsule(s.halfHeight, s.radius);
    }
  }

  raycast(origin: Vec2, direction: Vec2, maxDistance: number, groups?: number) {
    const ray = new RAPIER.Ray(v2(origin), v2(direction));
    const hit = this.rapier.castRayAndGetNormal(ray, maxDistance, true, undefined, groups);
    if (!hit) return null;
    return { collider: hit.collider.handle, point: v2(ray.pointAt(hit.timeOfImpact)), normal: v2(hit.normal), distance: hit.timeOfImpact };
  }

  castShape(shape: QueryShape2D, position: Vec2, rotation: number, direction: Vec2, maxDistance: number, groups?: number) {
    const hit = this.rapier.castShape(v2(position), rotation, v2(direction), this.queryShape(shape), 0, maxDistance, true, undefined, groups);
    if (!hit) return null;
    // World.castShape reports witness1/normal1 on the hit collider in world space.
    return { collider: hit.collider.handle, point: v2(hit.witness1), normal: v2(hit.normal1), distance: hit.time_of_impact };
  }

  castCollider(c: BackendCollider<Dim2>, direction: Vec2, maxDistance: number, groups: number, exclude: BackendBody<Dim2> | null) {
    const col = (c as Collider).c;
    const hit = this.rapier.castShape(col.translation(), col.rotation(), v2(direction), col.shape, 0, maxDistance, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups, col, (exclude as Body | null)?.rb);
    if (!hit) return null;
    const parent = hit.collider.parent();
    return { collider: hit.collider.handle, body: parent ? (this.bodies.get(parent.handle) ?? null) : null };
  }

  overlap(shape: QueryShape2D, position: Vec2, rotation: number, groups?: number): number[] {
    const found: number[] = [];
    this.rapier.intersectionsWithShape(v2(position), rotation, this.queryShape(shape), (c) => (found.push(c.handle), true), undefined, groups);
    return found;
  }

  overlapPoint(point: Vec2, groups?: number): number[] {
    const found: number[] = [];
    this.rapier.intersectionsWithPoint(v2(point), (c) => (found.push(c.handle), true), undefined, groups);
    return found;
  }
}

/** The Rapier 2D backend (ADR 0137). */
export const rapier2DBackend: PhysicsBackend2D = {
  capabilities: { characterController: true, jointMotors: true, continuousCollision: true, oneWayPlatforms: true, meshColliders: false },
  createWorld: (options) => new RapierWorld2D(options),
};
