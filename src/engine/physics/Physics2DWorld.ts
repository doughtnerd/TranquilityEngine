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
import { defineBuffer } from "../core/data";
import { defineBuiltinSystem } from "../core/systems";
import { DEG2RAD, RAD2DEG } from "../core/math";
import type { World } from "../core/World";
import { BoxCollider2D, CircleCollider2D, Collider2D, type Collision2D } from "./Collider2D";
import { RigidBody2D } from "./RigidBody2D";

/** Physics events for systems (ADR 0017). Filled during fixed steps, cleared at end of frame. */
export interface PhysicsEvent2D {
  readonly a: Collider2D;
  readonly b: Collider2D;
  readonly started: boolean;
}
export const TriggerEvents2D = defineBuffer<PhysicsEvent2D>("engine.TriggerEvents2D");
export const CollisionEvents2D = defineBuffer<PhysicsEvent2D>("engine.CollisionEvents2D");

/** @internal */
export interface BodyHandleState {
  body: RAPIER.RigidBody;
  signature: string;
  syncedVersion: number;
  active: boolean;
}

/** @internal */
export interface ColliderHandleState {
  collider: RAPIER.Collider;
  body: RigidBody2D | null;
  signature: string;
  syncedVersion: number;
  active: boolean;
}

let rapierReady: Promise<void> | null = null;

/** @internal Create the world's 2D physics world (initializing Rapier's WASM once). */
export async function ensurePhysics2D(world: World): Promise<Physics2DWorld> {
  await (rapierReady ??= RAPIER.init());
  if (!world.physics2D) world.physics2D = new Physics2DWorld(world);
  return world.physics2D;
}

/** @internal */
export class Physics2DWorld {
  readonly rapier: RAPIER.World;
  private readonly events = new RAPIER.EventQueue(true);
  private readonly colliderByHandle = new Map<number, Collider2D>();
  private readonly layerGroups = new Map<string, number>();

  constructor(private readonly world: World) {
    const [gx, gy] = world.settings.physics.gravity;
    this.rapier = new RAPIER.World({ x: gx, y: gy });
    this.buildLayerGroups();
  }

  get gravity(): { x: number; y: number } {
    return { x: this.rapier.gravity.x, y: this.rapier.gravity.y };
  }
  set gravity(g: { x: number; y: number }) {
    this.rapier.gravity = { x: g.x, y: g.y };
  }

  /** Layer name → Rapier interaction groups (membership in the high 16 bits, filter in the low 16). */
  private buildLayerGroups(): void {
    const { layers, collisionMatrix } = this.world.settings.physics;
    if (layers.length > 16) throw new Error("At most 16 physics layers are supported.");
    const filters = layers.map(() => (collisionMatrix ? 0 : 0xffff));
    if (collisionMatrix) {
      for (const [a, list] of Object.entries(collisionMatrix)) {
        const ia = layers.indexOf(a);
        if (ia < 0) throw new Error(`collisionMatrix: unknown layer "${a}".`);
        for (const b of list) {
          const ib = layers.indexOf(b);
          if (ib < 0) throw new Error(`collisionMatrix: unknown layer "${b}".`);
          filters[ia] |= 1 << ib;
          filters[ib] |= 1 << ia;
        }
      }
    }
    layers.forEach((name, i) => this.layerGroups.set(name, ((1 << i) << 16) | filters[i]));
  }

  private groupsFor(layer: string): number {
    const g = this.layerGroups.get(layer);
    if (g === undefined) {
      console.warn(`[tranquility] unknown physics layer "${layer}"; using "${this.world.settings.physics.layers[0]}".`);
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
      }
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
    return { body, signature: this.bodySignature(rb), syncedVersion: this.world.tVersion[rb.node.entity], active: true };
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
    if (!active || body) return;

    // Static collider without a body: follow the Transform when it changes.
    const version = this.world.tVersion[e];
    if (version !== st.syncedVersion) {
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
    const angle = t.worldRotation2D * DEG2RAD;
    const cx = c.center.x * ws.x, cy = c.center.y * ws.y;
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
    } else {
      throw new Error(`Unsupported collider type ${c.constructor.name}.`);
    }
    const pose = this.colliderWorldPose(c);
    if (body) {
      // Position relative to the body, in the body's rotated frame.
      const bt = body.node.transform;
      const bp = bt ? bt.worldPosition : { x: 0, y: 0 };
      const ba = bt ? bt.worldRotation2D * DEG2RAD : 0;
      const dx = pose.x - bp.x, dy = pose.y - bp.y;
      const cos = Math.cos(-ba), sin = Math.sin(-ba);
      desc.setTranslation(dx * cos - dy * sin, dx * sin + dy * cos).setRotation(pose.angle - ba).setDensity(0);
    } else {
      desc.setTranslation(pose.x, pose.y).setRotation(pose.angle);
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
    return { collider, body, signature, syncedVersion: this.world.tVersion[c.node.entity], active: true };
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
      if (!st || !st.active || rb.bodyType !== "dynamic" || st.body.isSleeping()) continue;
      const t = rb.node.transform;
      if (!t) continue;
      const p = st.body.translation();
      t._setWorldPose2D(p.x, p.y, st.body.rotation() * RAD2DEG);
      st.syncedVersion = world.tVersion[rb.node.entity];
    }
  }

  /** @internal */
  dispatchEvents(): void {
    this.events.drainCollisionEvents((h1, h2, started) => {
      const a = this.colliderByHandle.get(h1);
      const b = this.colliderByHandle.get(h2);
      if (!a || !b || a._destroyed || b._destroyed) return;
      const trigger = a.isTrigger || b.isTrigger;
      (trigger ? TriggerEvents2D : CollisionEvents2D).push({ a, b, started });
      this.notify(a, b, trigger, started);
      this.notify(b, a, trigger, started);
    });
  }

  /** Call the hook on active behaviors of `self`'s node, owner and body node. */
  private notify(self: Collider2D, other: Collider2D, trigger: boolean, started: boolean): void {
    const nodes = new Set([self.node.entity, self.owner.entity]);
    const body = self._state?.body;
    if (body?.node.isValid) nodes.add(body.node.entity);
    const hook = trigger ? (started ? "onTriggerEnter" : "onTriggerExit") : started ? "onCollisionEnter" : "onCollisionExit";
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
          console.error(`[tranquility] ${comp.constructor.name}.${hook} threw:`, err);
        }
      }
    }
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
    this.colliderByHandle.delete(st.collider.handle);
    if (this.rapier.getCollider(st.collider.handle)) this.rapier.removeCollider(st.collider, true);
    c._state = null;
  }
}

// The fixed-step physics systems, in the order of ADR 0011: catalog entries for every World, doing
// nothing in a World without a 2D physics world (ADR 0032).
defineBuiltinSystem({ name: "engine.PhysicsPush", phase: "fixedUpdate", after: ["engine.FixedUpdateScripts"], run: (w) => w.physics2D?.push() });
defineBuiltinSystem({ name: "engine.PhysicsStep", phase: "fixedUpdate", after: ["engine.PhysicsPush"], run: (w, dt) => w.physics2D?.step(dt) });
defineBuiltinSystem({ name: "engine.PhysicsWriteBack", phase: "fixedUpdate", after: ["engine.PhysicsStep"], run: (w) => w.physics2D?.writeBack() });
defineBuiltinSystem({ name: "engine.PhysicsEvents", phase: "fixedUpdate", after: ["engine.PhysicsWriteBack"], run: (w) => w.physics2D?.dispatchEvents() });
