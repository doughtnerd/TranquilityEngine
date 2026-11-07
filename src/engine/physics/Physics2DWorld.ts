/**
 * Rapier 2D physics backend (ADR 0005). Internal: game code uses RigidBody2D, Collider2D and
 * the Physics2D facade.
 *
 * Sync rules (ADR 0010):
 * - dynamic bodies: physics → Transform after each step; if a script moved the Transform since
 *   the last write-back, the body is teleported before the step.
 * - kinematic bodies: Transform → physics before each step (moved with velocity-aware kinematics).
 * - static bodies and colliders without a body: pushed when their Transform changes.
 */
import RAPIER from "@dimforge/rapier2d-compat";
import { GameBehavior } from "../core/Component";
import { DEG2RAD, RAD2DEG, Vector2 } from "../core/math";
import type { World } from "../core/World";
import { BoxCollider2D, CircleCollider2D, Collider2D, EdgeCollider2D, PolygonCollider2D, type Collision2D } from "./Collider2D";
import { layerGroups } from "./layers";
import { Queries2D } from "./queries2d";
import { cleanPoints, convexParts } from "./polygon";
import type { CollisionFlags } from "./CharacterController";
import { CharacterController2D, type ControllerColliderHit2D } from "./CharacterController2D";
import { CollisionEvents2D, TriggerEvents2D } from "./physics2dSystems";
import { RigidBody2D } from "./RigidBody2D";

/** @internal */
export interface BodyHandleState {
  body: RAPIER.RigidBody;
  signature: string;
  syncedVersion: number;
  active: boolean;
  /** Interpolation (ADR 0093): the body's pose before and after the last step, `[x, y, radians]`. */
  prev: number[] | null;
  curr: number[] | null;
  /** True while the Transform shows an interpolated pose rather than `curr`. */
  interpolated: boolean;
}

/** @internal */
export interface ColliderHandleState {
  collider: RAPIER.Collider;
  body: RigidBody2D | null;
  signature: string;
  syncedVersion: number;
  active: boolean;
  /** A collider on a body's descendant: its pose relative to the body `[x, y, radians]`, to follow the node when it moves (ADR 0093). */
  local?: number[] | null;
  /** A character controller's own kinematic body, which carries its collider (ADR 0091). */
  ownBody?: RAPIER.RigidBody;
}

let rapierReady: Promise<void> | null = null;

/** @internal Initialize Rapier 2D's WASM once (`ensurePhysics2D` in physics2d.ts calls it). */
export function initRapier2D(): Promise<void> {
  return (rapierReady ??= RAPIER.init().catch((err: unknown) => {
    rapierReady = null; // tried again next time
    throw err;
  }));
}

/** @internal */
export class Physics2DWorld {
  readonly rapier: RAPIER.World;
  /** @internal */
  readonly queries: Queries2D;
  private readonly events = new RAPIER.EventQueue(true);
  private readonly colliderByHandle = new Map<number, Collider2D>();
  private readonly layerGroups = new Map<string, number>();

  constructor(private readonly world: World) {
    const [gx, gy] = world.settings.physics.gravity;
    this.rapier = new RAPIER.World({ x: gx, y: gy });
    this.buildLayerGroups();
    this.queries = new Queries2D(this.rapier, (h) => this.colliderByHandle.get(h), (l) => this.groupsFor(l));
  }

  get gravity(): { x: number; y: number } {
    return { x: this.rapier.gravity.x, y: this.rapier.gravity.y };
  }
  set gravity(g: { x: number; y: number }) {
    this.rapier.gravity = { x: g.x, y: g.y };
  }

  /** Layer name → Rapier interaction groups (membership in the high 16 bits, filter in the low 16). */
  private buildLayerGroups(): void {
    for (const [name, groups] of layerGroups(this.world.settings.physics)) this.layerGroups.set(name, groups);
  }

  private groupsFor(layer: string): number {
    const g = this.layerGroups.get(layer);
    if (g === undefined) {
      console.warn(`[myco] unknown physics layer "${layer}"; using "${this.world.settings.physics.layers[0]}".`);
      return this.layerGroups.get(this.world.settings.physics.layers[0])!;
    }
    return g;
  }

  // --- fixed-step stages (the built-in systems below) ------------------------------------------

  /** @internal */
  push(): void {
    const world = this.world;
    for (const rb of world._componentsOfType(RigidBody2D)) this.pushBody(rb);
    for (const c of world._componentsOfType(Collider2D)) this.pushCollider(c);
  }

  private bodySignature(rb: RigidBody2D): string {
    const c = rb.constraints;
    return [rb.bodyType, rb.mass, rb.useGravity, rb.gravityScale, rb.drag, rb.angularDrag, c.freezePosition?.x, c.freezePosition?.y, c.freezeRotation, rb.collisionDetection].join("|");
  }

  private pushBody(rb: RigidBody2D): void {
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
    const t = rb.node.transform;
    const version = this.world.tVersion[e];
    if (t && version !== st.syncedVersion) {
      const p = t.worldPosition;
      const angle = t.worldRotation2D * DEG2RAD;
      if (rb.bodyType === "kinematic") {
        body.setNextKinematicTranslation({ x: p.x, y: p.y });
        body.setNextKinematicRotation(angle);
      } else {
        // Static body moved, or a script teleported a dynamic body.
        body.setTranslation({ x: p.x, y: p.y }, true);
        body.setRotation(angle, true);
        st.prev = st.curr = null; // teleported: nothing to blend from
      }
      st.interpolated = false;
      st.syncedVersion = version;
    }

    if (rb._pendingVelocity) {
      body.setLinvel({ x: rb._pendingVelocity[0], y: rb._pendingVelocity[1] }, true);
      rb._pendingVelocity = null;
    }
    if (rb._pendingAngularVelocity !== null) {
      body.setAngvel(rb._pendingAngularVelocity * DEG2RAD, true);
      rb._pendingAngularVelocity = null;
    }
    // "force" mode applies for exactly one step (Unity semantics); Rapier forces persist until reset.
    body.resetForces(false);
    body.resetTorques(false);
    if (rb._force[0] || rb._force[1]) body.addForce({ x: rb._force[0], y: rb._force[1] }, true);
    if (rb._torque) body.addTorque(rb._torque, true);
    rb._force[0] = rb._force[1] = 0;
    rb._torque = 0;
  }

  private createBody(rb: RigidBody2D): BodyHandleState {
    const t = rb.node.transform;
    const p = t ? t.worldPosition : { x: 0, y: 0 };
    const angle = t ? t.worldRotation2D * DEG2RAD : 0;
    const desc =
      rb.bodyType === "static" ? RAPIER.RigidBodyDesc.fixed() : rb.bodyType === "kinematic" ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic();
    desc.setTranslation(p.x, p.y).setRotation(angle);
    const body = this.rapier.createRigidBody(desc);
    this.applyBodySettings(rb, body);
    return { body, signature: this.bodySignature(rb), syncedVersion: this.world.tVersion[rb.node.entity], active: true, prev: null, curr: null, interpolated: false };
  }

  private applyBodySettings(rb: RigidBody2D, body: RAPIER.RigidBody): void {
    const type =
      rb.bodyType === "static" ? RAPIER.RigidBodyType.Fixed : rb.bodyType === "kinematic" ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic;
    if (body.bodyType() !== type) body.setBodyType(type, true);
    body.setGravityScale(rb.useGravity ? rb.gravityScale : 0, true);
    body.setLinearDamping(rb.drag);
    body.setAngularDamping(rb.angularDrag);
    const c = rb.constraints;
    body.setEnabledTranslations(!c.freezePosition?.x, !c.freezePosition?.y, true);
    body.lockRotations(!!c.freezeRotation, true);
    body.enableCcd(rb.collisionDetection === "continuous");
    // Colliders on bodies have zero density; the body's mass comes from `mass` (box-ish inertia).
    const mass = Math.max(rb.mass, 1e-4);
    body.setAdditionalMassProperties(mass, { x: 0, y: 0 }, mass / 6, true);
  }

  private pushCollider(c: Collider2D): void {
    const active = c.isActiveAndEnabled;
    const body = active ? c.attachedRigidbody : null;
    const t = c.node.transform;
    const e = c.node.entity;
    const ws = t ? t.worldScale : { x: 1, y: 1 };
    const signature = [c._shapeSignature(), c.isTrigger, c.layer, c.material?.friction, c.material?.bounciness, ws.x.toFixed(4), ws.y.toFixed(4), c.center.x, c.center.y].join("|");

    let st = c._state;
    if (st && (st.body !== body || st.signature !== signature || (body && !body._state))) {
      this.releaseCollider(c);
      st = null;
    }
    if (!st) {
      if (!active) return;
      if (body && !body._state) return; // body is created in the same push pass, earlier
      st = c._state = this.createCollider(c, body, signature);
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
        const local = this.poseInBody(c, body);
        const old = st.local;
        if (!old || Math.abs(local[0] - old[0]) > 1e-5 || Math.abs(local[1] - old[1]) > 1e-5 || Math.abs(local[2] - old[2]) > 1e-6) {
          st.collider.setTranslationWrtParent({ x: local[0], y: local[1] });
          st.collider.setRotationWrtParent(local[2]);
          st.local = local;
        }
        st.syncedVersion = version;
      }
      return;
    }

    // Static collider without a body: follow the Transform when it changes.
    if (version !== st.syncedVersion && st.ownBody) {
      const pose = this.colliderWorldPose(c);
      st.ownBody.setTranslation({ x: pose.x, y: pose.y }, true);
      this.rapier.propagateModifiedBodyPositionsToColliders();
      st.syncedVersion = version;
    } else if (version !== st.syncedVersion) {
      const pose = this.colliderWorldPose(c);
      st.collider.setTranslation({ x: pose.x, y: pose.y });
      st.collider.setRotation(pose.angle);
      st.syncedVersion = version;
    }
  }

  /** World-space pose of the collider shape (node pose plus rotated, scaled `center`). */
  private colliderWorldPose(c: Collider2D): { x: number; y: number; angle: number } {
    const t = c.node.transform;
    if (!t) return { x: c.center.x, y: c.center.y, angle: 0 };
    const p = t.worldPosition;
    const ws = t.worldScale;
    const cx = c.center.x * ws.x, cy = c.center.y * ws.y;
    // A character controller's capsule stays upright, whichever way its node turns.
    if (c instanceof CharacterController2D) return { x: p.x + cx, y: p.y + cy, angle: 0 };
    const angle = t.worldRotation2D * DEG2RAD;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    return { x: p.x + cx * cos - cy * sin, y: p.y + cx * sin + cy * cos, angle };
  }

  private createCollider(c: Collider2D, body: RigidBody2D | null, signature: string): ColliderHandleState {
    const t = c.node.transform;
    const ws = t ? t.worldScale : { x: 1, y: 1 };
    let desc: RAPIER.ColliderDesc;
    if (c instanceof BoxCollider2D) {
      desc = RAPIER.ColliderDesc.cuboid(Math.abs((c.size.x * ws.x) / 2), Math.abs((c.size.y * ws.y) / 2));
    } else if (c instanceof CircleCollider2D) {
      desc = RAPIER.ColliderDesc.ball(Math.abs(c.radius * Math.max(Math.abs(ws.x), Math.abs(ws.y))));
    } else if (c instanceof PolygonCollider2D || c instanceof EdgeCollider2D) {
      desc = this.pointsShape(c, ws);
    } else if (c instanceof CharacterController2D) {
      const r = Math.max(Math.abs(c.radius * ws.x), 1e-4);
      desc = RAPIER.ColliderDesc.capsule(Math.max(0, Math.abs(c.height * ws.y) / 2 - r), r);
    } else {
      throw new Error(`Unsupported collider type ${c.constructor.name}.`);
    }
    const pose = this.colliderWorldPose(c);
    let local: number[] | null = null;
    let ownBody: RAPIER.RigidBody | undefined;
    if (c instanceof CharacterController2D) {
      // On its own kinematic body, so it meets static triggers and level geometry (static–static pairs never do).
      ownBody = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pose.x, pose.y));
    } else if (body) {
      // Position relative to the body, in the body's rotated frame.
      local = this.poseInBody(c, body);
      desc.setTranslation(local[0], local[1]).setRotation(local[2]).setDensity(0);
    } else {
      desc.setTranslation(pose.x, pose.y).setRotation(pose.angle);
    }
    desc
      .setSensor(c.isTrigger)
      .setFriction(c.material?.friction ?? 0.5)
      .setRestitution(c.material?.bounciness ?? 0)
      .setCollisionGroups(this.groupsFor(c.layer))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      // A character controller is a parentless collider that moves: it must meet static triggers too.
      .setActiveCollisionTypes(c instanceof CharacterController2D ? RAPIER.ActiveCollisionTypes.ALL : RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED);
    const collider = this.rapier.createCollider(desc, ownBody ?? body?._state?.body);
    this.colliderByHandle.set(collider.handle, c);
    return { collider, body, signature, syncedVersion: this.world.tVersion[c.node.entity], active: true, local, ownBody };
  }

  /** The collider's shape pose in its body's frame, `[x, y, radians]`, from the two nodes' Transforms. */
  private poseInBody(c: Collider2D, body: RigidBody2D): number[] {
    const pose = this.colliderWorldPose(c);
    const bt = body.node.transform;
    const bp = bt ? bt.worldPosition : { x: 0, y: 0 };
    const ba = bt ? bt.worldRotation2D * DEG2RAD : 0;
    const dx = pose.x - bp.x, dy = pose.y - bp.y;
    const cos = Math.cos(-ba), sin = Math.sin(-ba);
    return [dx * cos - dy * sin, dx * sin + dy * cos, pose.angle - ba];
  }

  /**
   * A polygon (convex hull, or a compound of convex parts when concave) or an edge (polyline),
   * from the collider's points scaled by the node's world scale. A polygon that can't be split
   * (it crosses itself) collides along its closed outline; too few points make a tiny ball.
   */
  private pointsShape(c: PolygonCollider2D | EdgeCollider2D, ws: { x: number; y: number }): RAPIER.ColliderDesc {
    const scaled = cleanPoints(Array.isArray(c.points) ? c.points : []).map(([x, y]) => [x * ws.x, y * ws.y] as [number, number]);
    const flat = (pts: readonly (readonly number[])[]) => new Float32Array(pts.flatMap((p) => [p[0], p[1]]));
    if (c instanceof PolygonCollider2D) {
      const parts = convexParts(scaled);
      if (parts?.length === 1) {
        const hull = RAPIER.ColliderDesc.convexHull(flat(parts[0]));
        if (hull) return hull;
      } else if (parts) {
        const shapes = parts.map((p) => new RAPIER.ConvexPolygon(flat(p), true));
        return RAPIER.ColliderDesc.compound(shapes, shapes.map(() => ({ x: 0, y: 0 })), shapes.map(() => 0));
      }
      if (scaled.length >= 2) {
        console.warn(`[myco] ${c.node.name}: PolygonCollider2D points don't make a simple polygon; colliding along its outline.`);
        return RAPIER.ColliderDesc.polyline(flat([...scaled, scaled[0]]));
      }
    } else if (scaled.length >= 2) {
      return RAPIER.ColliderDesc.polyline(flat(scaled));
    }
    console.warn(`[myco] ${c.node.name}: ${c.constructor.name} needs more points.`);
    return RAPIER.ColliderDesc.ball(1e-4);
  }

  /** @internal */
  step(dt: number): void {
    this.rapier.timestep = dt;
    this.rapier.step(this.events);
  }

  /** @internal */
  writeBack(): void {
    const world = this.world;
    for (const rb of world._componentsOfType(RigidBody2D)) {
      const st = rb._state;
      if (!st || !st.active || rb.bodyType !== "dynamic") continue;
      if (st.body.isSleeping()) {
        if (st.curr) st.prev = st.curr; // at rest: nothing left to blend
        continue;
      }
      const t = rb.node.transform;
      if (!t) continue;
      const p = st.body.translation(), angle = st.body.rotation();
      if (rb.interpolate) {
        const pose = [p.x, p.y, angle];
        st.prev = st.curr ?? pose;
        st.curr = pose;
      } else {
        st.prev = st.curr = null;
      }
      t._setWorldPose2D(p.x, p.y, angle * RAD2DEG);
      st.interpolated = false;
      st.syncedVersion = world.tVersion[rb.node.entity];
    }
  }

  /**
   * @internal Interpolation (ADR 0093), in Worlds that render: show each interpolating dynamic body
   * `alpha` of the way from its pose before the last step to its pose after it.
   */
  interpolate(alpha: number): void {
    for (const rb of this.world._componentsOfType(RigidBody2D)) {
      const st = rb._state;
      if (!st?.prev || !st.curr || !st.active || !rb.interpolate || rb.bodyType !== "dynamic") continue;
      const t = rb.node.transform;
      if (!t || this.world.tVersion[rb.node.entity] !== st.syncedVersion) continue; // a script moved it: that wins
      const a = st.prev, b = st.curr;
      if (a === b && !st.interpolated) continue; // at rest and already showing it
      t._setWorldPose2D(a[0] + (b[0] - a[0]) * alpha, a[1] + (b[1] - a[1]) * alpha, (a[2] + (b[2] - a[2]) * alpha) * RAD2DEG);
      st.interpolated = true;
      st.syncedVersion = this.world.tVersion[rb.node.entity];
    }
  }

  /** @internal Before a fixed step's scripts: put interpolated bodies back at their simulated pose. */
  restoreInterpolated(): void {
    for (const rb of this.world._componentsOfType(RigidBody2D)) {
      const st = rb._state;
      if (!st?.interpolated || !st.curr) continue;
      st.interpolated = false;
      const t = rb.node.transform;
      if (!t || this.world.tVersion[rb.node.entity] !== st.syncedVersion) continue;
      t._setWorldPose2D(st.curr[0], st.curr[1], st.curr[2] * RAD2DEG);
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
      const a = this.colliderByHandle.get(h1);
      const b = this.colliderByHandle.get(h2);
      if (!a || !b || a._destroyed || b._destroyed) return;
      const trigger = a.isTrigger || b.isTrigger;
      this.world._buffer(trigger ? TriggerEvents2D : CollisionEvents2D).push({ a, b, started }); // this World's, whichever is current
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
  private notify(self: Collider2D, other: Collider2D, trigger: boolean, phase: "Enter" | "Stay" | "Exit"): void {
    const nodes = new Set([self.node.entity, self.owner.entity]);
    const body = self._state?.body;
    if (body?.node.isValid) nodes.add(body.node.entity);
    const hook = `${trigger ? "onTrigger" : "onCollision"}${phase}`;
    const collision: Collision2D | null = trigger
      ? null
      : { collider: other, otherCollider: self, gameObject: other.owner, rigidbody: other._state?.body ?? null };
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

  // --- character controllers (ADR 0091) -----------------------------------------------------------

  private readonly controllers = new Map<CharacterController2D, { kcc: RAPIER.KinematicCharacterController; settings: string }>();

  /** @internal Move a character controller by `motion`, sliding along what it hits; null before its collider exists. */
  moveCharacter(cc: CharacterController2D, motion: { x: number; y: number }): { movement: Vector2; flags: CollisionFlags; hits: ControllerColliderHit2D[] } | null {
    const st = cc._state;
    const t = cc.node.transform;
    if (!st || !st.active || !t) return null;
    let entry = this.controllers.get(cc);
    if (!entry) this.controllers.set(cc, (entry = { kcc: this.rapier.createCharacterController(cc.skinWidth), settings: "" }));
    const kcc = entry.kcc;
    const settings = cc._settingsSignature();
    if (entry.settings !== settings) {
      entry.settings = settings;
      kcc.setOffset(Math.max(cc.skinWidth, 1e-4));
      kcc.setSlideEnabled(true);
      kcc.setMaxSlopeClimbAngle(cc.slopeLimit * DEG2RAD);
      kcc.setMinSlopeSlideAngle(cc.slopeLimit * DEG2RAD);
      if (cc.stepOffset > 0) kcc.enableAutostep(cc.stepOffset, Math.max(Math.abs(cc.radius * t.worldScale.x) * 0.5, 0.01), true);
      else kcc.disableAutostep();
      if (cc.snapToGround > 0) kcc.enableSnapToGround(cc.snapToGround);
      else kcc.disableSnapToGround();
      kcc.setApplyImpulsesToDynamicBodies(cc.pushBodies);
      kcc.setCharacterMass(Math.max(cc.mass, 1e-4));
    }
    // Start from where the node is now (a script may have moved it since the last push).
    const start = this.colliderWorldPose(cc);
    const own = st.ownBody!;
    own.setTranslation({ x: start.x, y: start.y }, true);
    this.rapier.propagateModifiedBodyPositionsToColliders();
    kcc.computeColliderMovement(st.collider, { x: motion.x, y: motion.y }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, this.groupsFor(cc.layer));
    const m = kcc.computedMovement();
    own.setTranslation({ x: start.x + m.x, y: start.y + m.y }, true);
    this.rapier.propagateModifiedBodyPositionsToColliders();
    const p = t.worldPosition;
    t.worldPosition = [p.x + m.x, p.y + m.y, p.z];
    st.syncedVersion = this.world.tVersion[cc.node.entity];

    const len = Math.hypot(motion.x, motion.y);
    const dir = len > 0 ? new Vector2(motion.x / len, motion.y / len) : new Vector2();
    const cosSlope = Math.cos(cc.slopeLimit * DEG2RAD);
    let below = kcc.computedGrounded(), sides = false, above = false;
    const hits: ControllerColliderHit2D[] = [];
    for (let i = 0, n = kcc.numComputedCollisions(); i < n; i++) {
      const hit = kcc.computedCollision(i);
      if (!hit?.collider) continue;
      const other = this.colliderByHandle.get(hit.collider.handle);
      if (!other || other._destroyed) continue;
      const nrm = hit.normal1;
      if (nrm.y >= cosSlope - 1e-3) below = true;
      else if (nrm.y <= -cosSlope) above = true;
      else sides = true;
      const applied = hit.translationDeltaApplied;
      hits.push({
        controller: cc,
        collider: other,
        gameObject: other.owner,
        rigidbody: other._state?.body ?? null,
        point: new Vector2(hit.witness1.x, hit.witness1.y),
        normal: new Vector2(nrm.x, nrm.y),
        moveDirection: dir,
        moveLength: Math.hypot(applied.x, applied.y),
      });
    }
    return { movement: new Vector2(m.x, m.y), flags: { below, sides, above }, hits };
  }

  // --- queries ---------------------------------------------------------------------------------

  /** @internal */
  raycast(origin: { x: number; y: number }, dir: { x: number; y: number }, maxDistance: number, layers?: string[]) {
    const len = Math.hypot(dir.x, dir.y) || 1;
    const ray = new RAPIER.Ray({ x: origin.x, y: origin.y }, { x: dir.x / len, y: dir.y / len });
    let groups: number | undefined;
    if (layers?.length) {
      const mask = layers.reduce((m, l) => m | (this.groupsFor(l) >>> 16), 0);
      groups = (0xffff << 16) | mask;
    }
    const hit = this.rapier.castRayAndGetNormal(ray, maxDistance, true, undefined, groups);
    if (!hit) return null;
    const collider = this.colliderByHandle.get(hit.collider.handle);
    if (!collider) return null;
    const point = ray.pointAt(hit.timeOfImpact);
    return { collider, point: { x: point.x, y: point.y }, normal: { x: hit.normal.x, y: hit.normal.y }, distance: hit.timeOfImpact };
  }

  // --- release -------------------------------------------------------------------------------

  /** @internal */
  releaseBody(rb: RigidBody2D): void {
    const st = rb._state;
    if (!st) return;
    // Colliders attached to this body go with it; they are recreated (as static or on another body) next push.
    for (const c of this.world._componentsOfType(Collider2D)) {
      if (c._state?.body === rb) this.releaseCollider(c);
    }
    this.rapier.removeRigidBody(st.body);
    rb._state = null;
  }

  /** @internal */
  releaseCollider(c: Collider2D): void {
    const st = c._state;
    if (!st) return;
    const h = st.collider.handle;
    this.colliderByHandle.delete(h);
    if (c instanceof CharacterController2D) {
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
