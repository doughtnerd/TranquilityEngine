/**
 * The shared sync core's 2D half (ADR 0005, 0137): what `PhysicsCore` needs to know about 2D poses,
 * shapes and joints. Internal: game code uses RigidBody2D, the 2D colliders and the Physics2D facade.
 * Angles are radians here; Transforms and Components use degrees. Every node pose, scale and anchor is read
 * through the node's 2D frame (`scene/frame2d.ts`, ADR 0301), so a mirrored node stays mirrored; colliders and
 * joints describe their own shape (`_shapeFields`, `_jointFields`, `_worldAnchors`, ADR 0305).
 */
import { DEG2RAD, Vector2 } from "../../../../engine/core/math";
import type { World } from "../../../../engine/core/World";
import { cleanPoints, convexParts } from "../../../../engine/physics/polygon";
import { scaledCenter2D, shapeSignature, shapeSize2D } from "../../../../engine/physics/shape2d";
import { frame2DOf, frameDirection } from "../../../../engine/scene/frame2d";
import type { GameObject } from "../../../../engine/scene/GameObject";
import type { Transform } from "../../../../engine/scene/Transform";
import type { CharacterSettings, Dim2, JointDesc, JointSettings, PhysicsBackend2D, PhysicsWorld2DBackend, Pose, ShapeDesc2D, Vec2 } from "../backend";
import { CharacterController2D, type ControllerColliderHit2D } from "../CharacterController2D";
import { Collider2D } from "../Collider2D";
import { AxisJoint2D, Joint2D, type JointFields2D } from "../Joint2D";
import { RigidBody2D } from "../RigidBody2D";
import { CollisionEvents2D, TriggerEvents2D } from "../systems2d";
import { ShapeCollider2D } from "../ShapeCollider2D";
import { bodyInertia, bodyMass } from "../bodyCommands";
import { PhysicsCore } from "./PhysicsCore";
import type { JointState } from "./state";
import { oneWayOf, oneWayUp, type OneWay2D } from "./oneWay2d";
import { ShapeColliders2D } from "./shapeColliders2d";

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
  declare readonly backend: PhysicsWorld2DBackend;
  /** Shape colliders (ADR 0105, 0136, 0439). */
  private readonly shapes: ShapeColliders2D;

  constructor(world: World, backend: PhysicsBackend2D) {
    const [gx, gy] = world.settings.physics.gravity;
    super(world, backend, { x: gx, y: gy });
    this.shapes = new ShapeColliders2D({
      backend: this.backend,
      world,
      oneWay: this.capabilities.oneWayPlatforms,
      voxels: !!this.capabilities.voxelColliders && typeof this.backend.setVoxels === "function" && typeof this.backend.linkVoxels === "function",
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
    const f = frame2DOf(node);
    return { position: { x: f.position[0], y: f.position[1] }, rotation: f.angle };
  }

  protected relativePose(parent: P2, child: P2): P2 {
    const dx = child.position.x - parent.position.x, dy = child.position.y - parent.position.y;
    const [x, y] = this.rotate(-parent.rotation, [dx, dy]);
    return { position: { x, y }, rotation: child.rotation - parent.rotation };
  }

  protected writePose(t: Transform, pose: P2): void {
    t._setWorldPose2D(pose.position.x, pose.position.y, pose.rotation);
  }

  /** The short way round: a body turning past ±π doesn't spin back through 0 (ADR 0137). */
  protected lerpRotation(a: number, b: number, alpha: number): number {
    return a + wrapAngle(b - a) * alpha;
  }

  protected poseDiffers(a: P2, b: P2): boolean {
    return Math.abs(a.position.x - b.position.x) > 1e-5 || Math.abs(a.position.y - b.position.y) > 1e-5 || Math.abs(a.rotation - b.rotation) > 1e-6;
  }

  protected bodySettings(rb: RigidBody2D) {
    const c = rb.constraints, mass = bodyMass(rb.mass);
    return {
      type: rb.bodyType,
      mass,
      inertia: bodyInertia(rb.mass),
      gravityScale: rb.useGravity ? rb.gravityScale : 0,
      linearDamping: rb.drag,
      angularDamping: rb.angularDrag,
      lockTranslation: [!!c?.freezePosition?.x, !!c?.freezePosition?.y],
      lockRotation: [!!c?.freezeRotation],
      ccd: rb.collisionDetection === "continuous",
    };
  }


  // --- colliders -----------------------------------------------------------------------------------

  protected pushSpecialCollider(c: Collider2D): boolean {
    if (!(c instanceof ShapeCollider2D)) return false;
    this.shapes.push(c);
    return true;
  }

  protected releaseSpecialCollider(c: Collider2D): boolean {
    if (!(c instanceof ShapeCollider2D)) return false;
    this.shapes.release(c);
    return true;
  }

  protected releaseSpecialFor(rb: RigidBody2D): void {
    this.shapes.releaseFor(rb, this.world._componentsOfType(ShapeCollider2D));
  }

  protected colliderBody(c: Collider2D): RigidBody2D | null {
    return c._state?.body ?? (c instanceof ShapeCollider2D ? (c._shapeState?.body ?? null) : null);
  }

  protected colliderSource(c: Collider2D, active: boolean) {
    const frame = frame2DOf(c.node);
    const ws = frame.scale; // signed: a mirrored node's points and centre flip
    const parts: unknown[] = [shapeSignature(c._shapeFields()), c.isTrigger, c.layer, c.material?.friction, c.material?.bounciness, ws[0].toFixed(4), ws[1].toFixed(4), c.center.x, c.center.y];
    if (this.isOneWay(c)) {
      // A one-way collider's top is fixed when built; without a body to carry it, moving or turning the node rebuilds it.
      parts.push("oneWay");
      if (!(active && c.attachedRigidbody)) parts.push(frame.position[0].toFixed(5), frame.position[1].toFixed(5), frame.angle.toFixed(6));
    }
    return { signature: parts.join("|"), scale: ws };
  }

  /** Whether `c` is built one-way (ADR 0439): its `oneWay` is on and it isn't a trigger or a character controller. */
  private isOneWay(c: Collider2D): boolean {
    return c.oneWay && !c.isTrigger && !(c instanceof CharacterController2D);
  }

  protected colliderOneWay(c: Collider2D, shape: ShapeDesc2D): OneWay2D | null {
    if (!this.isOneWay(c)) return null;
    if (!this.capabilities.oneWayPlatforms) {
      this.warnOnce("oneway", "this physics backend has no one-way platforms; one-way colliders are solid.");
      return null;
    }
    return oneWayOf(shape, this.colliderWorldPose(c), oneWayUp(frame2DOf(c.node)));
  }

  /** @internal `RigidBody2D.dropThrough` and `CharacterController2D.dropThrough` (ADR 0439). */
  dropThrough(target: RigidBody2D | CharacterController2D): void {
    if (!this.capabilities.oneWayPlatforms) return;
    const body = target instanceof RigidBody2D ? target._state?.body : target._state?.ownBody;
    if (body && !body.removed) this.backend.dropThrough(body);
  }

  protected colliderShape(c: Collider2D, scale: readonly number[]): ShapeDesc2D {
    const fields = c._shapeFields();
    switch (fields.kind) {
      case "polygon":
      case "edge":
        return this.pointsShape(c, fields.kind === "polygon", fields.points, scale[0], scale[1]);
      case "source":
        throw new Error(`${c.constructor.name}'s shapes are built by the shape colliders.`);
      default: {
        const size = shapeSize2D(fields, scale);
        return size.kind === "box" ? { kind: "box", halfExtents: { x: size.halfExtents[0], y: size.halfExtents[1] } } : size;
      }
    }
  }

  /**
   * A polygon (convex hull, or a compound of convex parts when concave) or an edge (polyline), from the
   * collider's points scaled by the node's (signed) frame scale. A polygon that can't be split (it crosses itself)
   * collides along its closed outline; too few points make a tiny circle.
   */
  private pointsShape(c: Collider2D, closed: boolean, points: readonly unknown[], sx: number, sy: number): ShapeDesc2D {
    const scaled = cleanPoints(Array.isArray(points) ? (points as [number, number][]) : []).map(([x, y]) => [x * sx, y * sy] as const);
    const type = c.constructor.name;
    if (closed) {
      const parts = convexParts(scaled);
      if (parts) return { kind: "convexPolygons", parts, outline: scaled, label: `${c.node.name}: ${type}` };
      if (scaled.length >= 2) {
        console.warn(`[myco] ${c.node.name}: ${type} points don't make a simple polygon; colliding along its outline.`);
        return { kind: "polyline", points: [...scaled, scaled[0]] };
      }
    } else if (scaled.length >= 2) {
      return { kind: "polyline", points: scaled };
    }
    console.warn(`[myco] ${c.node.name}: ${type} needs more points.`);
    return { kind: "circle", radius: 1e-4 };
  }

  /** World-space pose of the collider shape: the node's frame plus its turned, (signed-)scaled `center`. */
  protected colliderWorldPose(c: Collider2D): P2 {
    if (!c.node.transform) return { position: { x: c.center.x, y: c.center.y }, rotation: 0 };
    const f = frame2DOf(c.node);
    const [cx, cy] = scaledCenter2D([c.center.x, c.center.y], f.scale);
    const [px, py] = f.position;
    // A capsule (a character controller's) stays upright, whichever way its node turns.
    if (c._shapeFields().kind === "capsule") return { position: { x: px + cx, y: py + cy }, rotation: 0 };
    const [ox, oy] = this.rotate(f.angle, [cx, cy]);
    return { position: { x: px + ox, y: py + oy }, rotation: f.angle };
  }

  // --- joints --------------------------------------------------------------------------------------

  protected jointAnchorSignature(j: Joint2D): unknown[] {
    return [j.anchor.x, j.anchor.y, j.autoConfigureConnectedAnchor, j.connectedAnchor.x, j.connectedAnchor.y];
  }

  protected jointDesc(j: Joint2D, p1: P2, p2: P2) {
    const fields = j._jointFields();
    const { anchor, connected } = j._worldAnchors();
    const pw: Vec2 = { x: anchor[0], y: anchor[1] }, pw2: Vec2 = connected ? { x: connected[0], y: connected[1] } : pw;
    const a1 = this.relativePose(p1, { position: pw, rotation: 0 }).position, a2 = this.relativePose(p2, { position: pw2, rotation: 0 }).position;
    const dist = Math.hypot(pw2.x - pw.x, pw2.y - pw.y);
    const restAngle = p1.rotation - p2.rotation;
    const base = { anchor1: a2, anchor2: a1 };
    let desc: Omit<JointDesc<Dim2>, "body1" | "body2" | "contacts">;
    switch (fields.kind) {
      case "fixed":
        desc = { kind: "fixed", ...base, frame1: 0, frame2: -restAngle };
        break;
      case "hinge":
        desc = { kind: "revolute", ...base };
        break;
      case "slider": {
        if (Math.abs(restAngle) > 1e-4) this.warnOnce(`slider:${j.node.entity}`, `${j.node.name}: SliderJoint2D's bodies should start at the same rotation; it turns them to match.`);
        // The axis in world space through the node's frame (mirrored with it), then in the connected body's frame.
        const [wx, wy] = frameDirection(frame2DOf(j.node), fields.axis);
        const len = Math.hypot(wx, wy);
        const [x, y] = len > 1e-12 ? this.rotate(-p2.rotation, [wx / len, wy / len]) : this.rotate(-p2.rotation, [1, 0]);
        desc = { kind: "prismatic", ...base, axis: { x, y } };
        break;
      }
      case "rope":
        desc = { kind: "rope", ...base, length: fields.length ?? dist };
        break;
      case "spring":
        desc = { kind: "spring", ...base, length: fields.length ?? dist, stiffness: fields.stiffness, damping: fields.damping };
        break;
    }
    if ((fields.kind === "hinge" || fields.kind === "slider") && fields.limits) desc = { ...desc, limits: this.limitsOf(fields, restAngle) };
    return { desc, local1: a1, local2: a2, restAngle };
  }

  /** A hinge's or slider's limits (hinges count from the angle they were made at). */
  private limitsOf(fields: Extract<JointFields2D, { kind: "hinge" | "slider" }>, restAngle: number): [number, number] | null {
    const l = fields.limits;
    if (!l) return null;
    const lo = Math.min(l.min, l.max), hi = Math.max(l.min, l.max);
    return fields.kind === "hinge" ? [lo * DEG2RAD + restAngle, hi * DEG2RAD + restAngle] : [lo, hi];
  }

  protected jointSettings(j: Joint2D, st: JointState<Dim2, RigidBody2D>): JointSettings | null {
    const fields = j._jointFields();
    if (!(j instanceof AxisJoint2D) || (fields.kind !== "hinge" && fields.kind !== "slider")) return null;
    const hinge = fields.kind === "hinge", k = hinge ? DEG2RAD : 1, offset = hinge ? st.restAngle : 0;
    return {
      limits: this.limitsOf(fields, st.restAngle),
      motor: j.useMotor ? { targetVelocity: (j.motor?.targetVelocity ?? 0) * k, maxForce: Math.max(j.motor?.force ?? 0, 0) } : null,
      spring: !j.useMotor && j.useSpring ? { target: (j.spring?.targetPosition ?? 0) * k + offset, stiffness: j.spring?.spring ?? 0, damping: j.spring?.damper ?? 0 } : null,
    };
  }

  // --- character controllers -----------------------------------------------------------------------

  protected characterSettings(cc: CharacterController2D): CharacterSettings {
    const ws = frame2DOf(cc.node).scale;
    return {
      offset: Math.max(cc.skinWidth, 1e-4),
      slopeLimit: cc.slopeLimit * DEG2RAD,
      autostep: cc.stepOffset > 0 ? { height: cc.stepOffset, minWidth: Math.max(Math.abs(cc.radius * ws[0]) * 0.5, 0.01) } : null,
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
