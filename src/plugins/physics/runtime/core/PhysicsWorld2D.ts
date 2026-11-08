/**
 * The shared sync core's 2D half (ADR 0005, 0137): what `PhysicsCore` needs to know about 2D poses,
 * shapes and joints. Internal: game code uses RigidBody2D, the 2D colliders and the Physics2D facade.
 * Angles are radians here; Transforms and Components use degrees.
 */
import { DEG2RAD, Mat4, RAD2DEG, Vector2 } from "../../../../engine/core/math";
import type { World } from "../../../../engine/core/World";
import { cleanPoints, convexParts } from "../../../../engine/physics/polygon";
import type { GameObject } from "../../../../engine/scene/GameObject";
import type { Transform } from "../../../../engine/scene/Transform";
import type { CharacterSettings, Dim2, JointDesc, JointSettings, PhysicsBackend2D, Pose, ShapeDesc2D, Vec2 } from "../backend";
import { CharacterController2D, type ControllerColliderHit2D } from "../CharacterController2D";
import { BoxCollider2D, CircleCollider2D, Collider2D, EdgeCollider2D, PolygonCollider2D } from "../Collider2D";
import { AxisJoint2D, FixedJoint2D, HingeJoint2D, Joint2D, RopeJoint2D, SliderJoint2D, SpringJoint2D } from "../Joint2D";
import { RigidBody2D } from "../RigidBody2D";
import { CollisionEvents2D, TriggerEvents2D } from "../systems2d";
import { TilemapCollider2D } from "../TilemapCollider2D";
import { PhysicsCore } from "./PhysicsCore";
import type { JointState } from "./state";
import { TilemapColliders2D } from "./tilemap2d";

interface Types2D {
  body: RigidBody2D;
  collider: Collider2D;
  character: CharacterController2D;
  joint: Joint2D;
  hit: ControllerColliderHit2D;
  movement: Vector2;
}

type P2 = Pose<Dim2>;

/** Wrap an angle into (-π, π]. */
export function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  a = ((a % t) + t) % t;
  return a > Math.PI ? a - t : a;
}

/** @internal One World's 2D physics: the shared core over a 2D backend. */
export class PhysicsWorld2D extends PhysicsCore<Dim2, Types2D> {
  protected readonly Body = RigidBody2D;
  protected readonly Collider = Collider2D;
  protected readonly Character = CharacterController2D;
  protected readonly Joint = Joint2D;
  protected readonly triggerEvents = TriggerEvents2D;
  protected readonly collisionEvents = CollisionEvents2D;
  protected readonly bodyName = "RigidBody2D";
  protected readonly down = { x: 0, y: -1 };
  protected readonly identity = 0;
  /** Tilemap colliders and one-way platforms (ADR 0105). */
  private readonly tilemaps: TilemapColliders2D;

  constructor(world: World, backend: PhysicsBackend2D) {
    const [gx, gy] = world.settings.physics.gravity;
    super(world, backend, { x: gx, y: gy });
    this.tilemaps = new TilemapColliders2D({
      backend: this.backend,
      world,
      oneWay: this.capabilities.oneWayPlatforms,
      groupsFor: (layer) => this.groupsFor(layer),
      register: (id, c) => this.colliderById.set(id, c),
      unregister: (id) => void this.colliderById.delete(id),
      warnOnce: (key, message) => this.warnOnce(key, message),
    });
  }

  protected vec(a: readonly number[]): Vec2 {
    return { x: a[0], y: a[1] };
  }
  protected ang(a: readonly number[]): number {
    return a[0];
  }
  protected rotate(r: number, v: readonly number[]): number[] {
    const c = Math.cos(r), s = Math.sin(r);
    return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
  }

  protected nodePose(node: GameObject): P2 {
    const t = node.transform;
    if (!t) return { position: { x: 0, y: 0 }, rotation: 0 };
    const p = t.worldPosition;
    return { position: { x: p.x, y: p.y }, rotation: t.worldRotation2D * DEG2RAD };
  }

  protected relativePose(parent: P2, child: P2): P2 {
    const dx = child.position.x - parent.position.x, dy = child.position.y - parent.position.y;
    const [x, y] = this.rotate(-parent.rotation, [dx, dy]);
    return { position: { x, y }, rotation: child.rotation - parent.rotation };
  }

  protected writePose(t: Transform, pose: P2): void {
    t._setWorldPose2D(pose.position.x, pose.position.y, pose.rotation * RAD2DEG);
  }

  /** The short way round: a body turning past ±π doesn't spin back through 0 (ADR 0137). */
  protected lerpRotation(a: number, b: number, alpha: number): number {
    return a + wrapAngle(b - a) * alpha;
  }

  protected poseDiffers(a: P2, b: P2): boolean {
    return Math.abs(a.position.x - b.position.x) > 1e-5 || Math.abs(a.position.y - b.position.y) > 1e-5 || Math.abs(a.rotation - b.rotation) > 1e-6;
  }

  protected bodySettings(rb: RigidBody2D) {
    const c = rb.constraints, mass = Math.max(rb.mass, 1e-4);
    return {
      type: rb.bodyType,
      mass,
      inertia: mass / 6, // box-ish: colliders on bodies have no density
      gravityScale: rb.useGravity ? rb.gravityScale : 0,
      linearDamping: rb.drag,
      angularDamping: rb.angularDrag,
      lockTranslation: [!!c?.freezePosition?.x, !!c?.freezePosition?.y],
      lockRotation: [!!c?.freezeRotation],
      ccd: rb.collisionDetection === "continuous",
    };
  }

  protected takePending(rb: RigidBody2D) {
    const velocity = rb._pendingVelocity ? [...rb._pendingVelocity] : null;
    const angularVelocity = rb._pendingAngularVelocity !== null ? [rb._pendingAngularVelocity * DEG2RAD] : null;
    rb._pendingVelocity = null;
    rb._pendingAngularVelocity = null;
    const force = [rb._force[0], rb._force[1]], torque = [rb._torque];
    rb._force[0] = rb._force[1] = 0;
    rb._torque = 0;
    return { velocity, angularVelocity, force, torque };
  }

  // --- colliders -----------------------------------------------------------------------------------

  protected pushSpecialCollider(c: Collider2D): boolean {
    if (!(c instanceof TilemapCollider2D)) return false;
    this.tilemaps.push(c);
    return true;
  }

  protected releaseSpecialCollider(c: Collider2D): boolean {
    if (!(c instanceof TilemapCollider2D)) return false;
    this.tilemaps.release(c);
    return true;
  }

  protected releaseSpecialFor(rb: RigidBody2D): void {
    this.tilemaps.releaseFor(rb, this.world._componentsOfType(TilemapCollider2D));
  }

  protected colliderBody(c: Collider2D): RigidBody2D | null {
    return c._state?.body ?? (c instanceof TilemapCollider2D ? (c._tileState?.body ?? null) : null);
  }

  protected colliderSource(c: Collider2D) {
    const t = c.node.transform;
    const ws = t ? t.worldScale : { x: 1, y: 1 };
    const signature = [c._shapeSignature(), c.isTrigger, c.layer, c.material?.friction, c.material?.bounciness, ws.x.toFixed(4), ws.y.toFixed(4), c.center.x, c.center.y].join("|");
    return { signature, scale: [ws.x, ws.y] };
  }

  protected colliderShape(c: Collider2D, scale: readonly number[]): ShapeDesc2D {
    const [sx, sy] = scale;
    if (c instanceof BoxCollider2D) return { kind: "box", halfExtents: { x: Math.abs((c.size.x * sx) / 2), y: Math.abs((c.size.y * sy) / 2) } };
    if (c instanceof CircleCollider2D) return { kind: "circle", radius: Math.abs(c.radius * Math.max(Math.abs(sx), Math.abs(sy))) };
    if (c instanceof PolygonCollider2D || c instanceof EdgeCollider2D) return this.pointsShape(c, sx, sy);
    if (c instanceof CharacterController2D) {
      const r = Math.max(Math.abs(c.radius * sx), 1e-4);
      return { kind: "capsule", radius: r, halfHeight: Math.max(0, Math.abs(c.height * sy) / 2 - r) };
    }
    throw new Error(`Unsupported collider type ${c.constructor.name}.`);
  }

  /**
   * A polygon (convex hull, or a compound of convex parts when concave) or an edge (polyline), from the
   * collider's points scaled by the node's world scale. A polygon that can't be split (it crosses itself)
   * collides along its closed outline; too few points make a tiny circle.
   */
  private pointsShape(c: PolygonCollider2D | EdgeCollider2D, sx: number, sy: number): ShapeDesc2D {
    const scaled = cleanPoints(Array.isArray(c.points) ? c.points : []).map(([x, y]) => [x * sx, y * sy] as const);
    if (c instanceof PolygonCollider2D) {
      const parts = convexParts(scaled);
      if (parts) return { kind: "convexPolygons", parts, outline: scaled, label: `${c.node.name}: PolygonCollider2D` };
      if (scaled.length >= 2) {
        console.warn(`[myco] ${c.node.name}: PolygonCollider2D points don't make a simple polygon; colliding along its outline.`);
        return { kind: "polyline", points: [...scaled, scaled[0]] };
      }
    } else if (scaled.length >= 2) {
      return { kind: "polyline", points: scaled };
    }
    console.warn(`[myco] ${c.node.name}: ${c.constructor.name} needs more points.`);
    return { kind: "circle", radius: 1e-4 };
  }

  /** World-space pose of the collider shape (node pose plus rotated, scaled `center`). */
  protected colliderWorldPose(c: Collider2D): P2 {
    const t = c.node.transform;
    if (!t) return { position: { x: c.center.x, y: c.center.y }, rotation: 0 };
    const p = t.worldPosition;
    const ws = t.worldScale;
    const cx = c.center.x * ws.x, cy = c.center.y * ws.y;
    // A character controller's capsule stays upright, whichever way its node turns.
    if (c instanceof CharacterController2D) return { position: { x: p.x + cx, y: p.y + cy }, rotation: 0 };
    const angle = t.worldRotation2D * DEG2RAD;
    const [ox, oy] = this.rotate(angle, [cx, cy]);
    return { position: { x: p.x + ox, y: p.y + oy }, rotation: angle };
  }

  // --- joints --------------------------------------------------------------------------------------

  protected jointAnchorSignature(j: Joint2D): unknown[] {
    return [j.anchor.x, j.anchor.y, j.autoConfigureConnectedAnchor, j.connectedAnchor.x, j.connectedAnchor.y];
  }

  /** A point in a node's local space, in world space. */
  private pointOf(node: GameObject, local: { x: number; y: number }): Vec2 {
    if (!node.transform) return { x: local.x, y: local.y };
    const [x, y] = Mat4.transformPoint(this.world.worldMatrix(node.entity), node.entity * 16, local.x, local.y, 0);
    return { x, y };
  }

  protected jointDesc(j: Joint2D, p1: P2, p2: P2, connected: RigidBody2D | null) {
    const pw = this.pointOf(j.node, j.anchor);
    const distanceJoint = j instanceof RopeJoint2D || j instanceof SpringJoint2D;
    let pw2: Vec2;
    if (!j.autoConfigureConnectedAnchor) pw2 = connected ? this.pointOf(j.connectedBody!, j.connectedAnchor) : { x: j.connectedAnchor.x, y: j.connectedAnchor.y };
    else if (distanceJoint && connected) pw2 = { ...p2.position };
    else pw2 = pw;
    const a1 = this.relativePose(p1, { position: pw, rotation: 0 }).position, a2 = this.relativePose(p2, { position: pw2, rotation: 0 }).position;
    const dist = Math.hypot(pw2.x - pw.x, pw2.y - pw.y);
    const restAngle = p1.rotation - p2.rotation;
    const base = { anchor1: a2, anchor2: a1 };
    let desc: Omit<JointDesc<Dim2>, "body1" | "body2" | "contacts">;
    if (j instanceof FixedJoint2D) desc = { kind: "fixed", ...base, frame1: 0, frame2: -restAngle };
    else if (j instanceof HingeJoint2D) desc = { kind: "revolute", ...base };
    else if (j instanceof SliderJoint2D) {
      if (Math.abs(restAngle) > 1e-4) this.warnOnce(`slider:${j.node.entity}`, `${j.node.name}: SliderJoint2D's bodies should start at the same rotation; it turns them to match.`);
      const t = j.node.transform;
      const turn = t ? t.worldRotation2D * DEG2RAD - p2.rotation : 0;
      const len = Math.hypot(j.axis.x, j.axis.y) || 1;
      const [x, y] = this.rotate(turn, [j.axis.x / len, j.axis.y / len]);
      desc = { kind: "prismatic", ...base, axis: { x, y } };
    } else if (j instanceof RopeJoint2D) desc = { kind: "rope", ...base, length: j.autoConfigureDistance ? dist : Math.max(j.maxDistance, 0) };
    else if (j instanceof SpringJoint2D) desc = { kind: "spring", ...base, length: j.autoConfigureDistance ? dist : Math.max(j.restLength, 0), stiffness: j.spring, damping: j.damper };
    else throw new Error(`Unsupported joint type ${j.constructor.name}.`);
    if (j instanceof AxisJoint2D && j.useLimits) desc = { ...desc, limits: this.limitsOf(j, restAngle) };
    return { desc, local1: a1, local2: a2, restAngle };
  }

  /** A hinge's or slider's limits (hinges count from the angle they were made at). */
  private limitsOf(j: AxisJoint2D, restAngle: number): [number, number] {
    const lo = Math.min(j.limits.min, j.limits.max), hi = Math.max(j.limits.min, j.limits.max);
    return j instanceof HingeJoint2D ? [lo * DEG2RAD + restAngle, hi * DEG2RAD + restAngle] : [lo, hi];
  }

  protected jointSettings(j: Joint2D, st: JointState<Dim2, RigidBody2D>): JointSettings | null {
    if (!(j instanceof AxisJoint2D)) return null;
    const hinge = j instanceof HingeJoint2D, k = hinge ? DEG2RAD : 1, offset = hinge ? st.restAngle : 0;
    return {
      limits: j.useLimits ? this.limitsOf(j, st.restAngle) : null,
      motor: j.useMotor ? { targetVelocity: (j.motor?.targetVelocity ?? 0) * k, maxForce: Math.max(j.motor?.force ?? 0, 0) } : null,
      spring: !j.useMotor && j.useSpring ? { target: (j.spring?.targetPosition ?? 0) * k + offset, stiffness: j.spring?.spring ?? 0, damping: j.spring?.damper ?? 0 } : null,
    };
  }

  // --- character controllers -----------------------------------------------------------------------

  protected characterSettings(cc: CharacterController2D): CharacterSettings {
    const ws = cc.node.transform?.worldScale ?? { x: 1, y: 1 };
    return {
      offset: Math.max(cc.skinWidth, 1e-4),
      slopeLimit: cc.slopeLimit * DEG2RAD,
      autostep: cc.stepOffset > 0 ? { height: cc.stepOffset, minWidth: Math.max(Math.abs(cc.radius * ws.x) * 0.5, 0.01) } : null,
      snapToGround: cc.snapToGround > 0 ? cc.snapToGround : null,
      pushBodies: cc.pushBodies,
      mass: Math.max(cc.mass, 1e-4),
    };
  }

  protected moveNode(cc: CharacterController2D, _start: Vec2, m: Vec2): void {
    const t = cc.node.transform!;
    const p = t.worldPosition;
    t.worldPosition = [p.x + m.x, p.y + m.y, p.z];
  }

  protected carried(from: P2, to: P2, p: Vec2): Vec2 {
    const [x, y] = this.rotate(to.rotation - from.rotation, [p.x - from.position.x, p.y - from.position.y]);
    return { x: to.position.x + x - p.x, y: to.position.y + y - p.y };
  }

  protected controllerHit(cc: CharacterController2D, other: Collider2D, point: Vec2, normal: Vec2, dir: number[], moveLength: number): ControllerColliderHit2D {
    return { controller: cc, collider: other, gameObject: other.owner, rigidbody: other._state?.body ?? null, point: new Vector2(point.x, point.y), normal: new Vector2(normal.x, normal.y), moveDirection: new Vector2(dir[0], dir[1]), moveLength };
  }

  protected movement(v: Vec2): Vector2 {
    return new Vector2(v.x, v.y);
  }
}
