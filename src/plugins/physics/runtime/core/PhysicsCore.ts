/**
 * The shared physics sync core (ADR 0137), written once for 2D and 3D: it reads the physics Components
 * and drives a backend (`PhysicsWorldBackend`) through neutral descriptions. Loaded with the backend, in
 * a lazy chunk, by the Physics plugin's World services. `PhysicsWorld2D` and `PhysicsWorld3D` supply what
 * differs per dimension: node poses, shapes, joint frames and rotation maths.
 *
 * Sync rules (ADR 0010):
 * - dynamic bodies: physics → Transform after each step; if a script moved the Transform since the last
 *   write-back, the body is teleported before the step;
 * - kinematic bodies: Transform → physics before each step (moved with velocity-aware kinematics);
 * - static bodies and colliders without a body: pushed when their Transform changes.
 */
import { GameBehavior, type Component } from "../../../../engine/core/Component";
import type { BufferDef } from "../../../../engine/core/data";
import type { World } from "../../../../engine/core/World";
import { layerGroups } from "../../../../engine/physics/layers";
import type { BodyType, CollisionFlags } from "../../../../engine/physics/types";
import { GameObject } from "../../../../engine/scene/GameObject";
import type { Transform } from "../../../../engine/scene/Transform";
import type { BackendBody, BackendCharacter, BackendCollider, BodySettings, CharacterSettings, DimensionTypes, JointDesc, JointSettings, PhysicsCapabilities, PhysicsWorldBackend, Pose } from "../backend";
import type { BodyState, ColliderState, JointState } from "./state";

/** @internal The RigidBody fields the core reads, in either dimension. */
export interface BodyComponent<D extends DimensionTypes> extends Component {
  bodyType: BodyType;
  mass: number;
  useGravity: boolean;
  gravityScale: number;
  drag: number;
  angularDrag: number;
  interpolate: boolean;
  _state: BodyState<D> | null;
}

/** @internal The collider fields the core reads. */
export interface ColliderComponent<D extends DimensionTypes, RB> extends Component {
  isTrigger: boolean;
  layer: string;
  material: { friction: number; bounciness: number } | null | undefined;
  readonly attachedRigidbody: RB | null;
  _state: ColliderState<D, RB> | null;
  _shapeSignature(): string;
}

/** @internal The character controller fields the core reads. */
export interface CharacterComponent<D extends DimensionTypes, RB> extends ColliderComponent<D, RB> {
  slopeLimit: number;
  stepOffset: number;
  skinWidth: number;
  snapToGround: number;
  pushBodies: boolean;
  mass: number;
  moveWithPlatforms: boolean;
  readonly isGrounded: boolean;
  _flags: CollisionFlags;
  _settingsSignature(): string;
}

/** @internal The joint fields the core reads. */
export interface JointComponent<D extends DimensionTypes, RB> extends Component {
  connectedBody: GameObject | null;
  autoConfigureConnectedAnchor: boolean;
  enableCollision: boolean;
  breakForce: number;
  breakTorque: number;
  readonly body: RB | null;
  readonly connectedRigidbody: RB | null;
  _state: JointState<D, RB> | null;
  _broken: boolean;
  _jointSignature(): string;
  _settingsSignature(): string;
}

/** A physics event for systems (ADR 0017). */
interface PhysicsEventOf<C> {
  readonly a: C;
  readonly b: C;
  readonly started: boolean;
}

/** What the core's dimension classes are made from. */
export interface CoreTypes<D extends DimensionTypes> {
  body: BodyComponent<D>;
  collider: ColliderComponent<D, this["body"]>;
  character: CharacterComponent<D, this["body"]> & this["collider"];
  joint: JointComponent<D, this["body"]>;
  /** What `onControllerColliderHit` gets, and a character's movement (Vector2 or Vector3). */
  hit: unknown;
  movement: unknown;
}

type Hook = "Enter" | "Stay" | "Exit";

/** @internal */
export abstract class PhysicsCore<D extends DimensionTypes, T extends CoreTypes<D>> {
  readonly backend: PhysicsWorldBackend<D>;
  protected readonly colliderById = new Map<number, T["collider"]>();
  private readonly layerGroups: Map<string, number>;
  private readonly warned = new Set<string>();
  /** The last fixed step's length (joint breaks need it). */
  private dt = 0;

  // --- what each dimension supplies ---------------------------------------------------------------

  protected abstract readonly Body: abstract new () => T["body"];
  protected abstract readonly Collider: abstract new () => T["collider"];
  protected abstract readonly Character: abstract new () => T["character"];
  protected abstract readonly Joint: abstract new () => T["joint"];
  protected abstract readonly triggerEvents: BufferDef<PhysicsEventOf<T["collider"]>>;
  protected abstract readonly collisionEvents: BufferDef<PhysicsEventOf<T["collider"]>>;
  /** "RigidBody2D" or "RigidBody", for messages. */
  protected abstract readonly bodyName: string;
  /** Straight down. */
  protected abstract readonly down: D["vec"];
  protected abstract readonly identity: D["rot"];

  protected abstract vec(a: readonly number[]): D["vec"];
  protected abstract ang(a: readonly number[]): D["ang"];
  /** Rotate a vector (as numbers) by a rotation. */
  protected abstract rotate(r: D["rot"], v: readonly number[]): number[];
  /** A node's world pose (scale left out). */
  protected abstract nodePose(node: GameObject): Pose<D>;
  /** `child` in `parent`'s frame. */
  protected abstract relativePose(parent: Pose<D>, child: Pose<D>): Pose<D>;
  protected abstract writePose(t: Transform, pose: Pose<D>): void;
  /** Rotation `alpha` of the way from `a` to `b`, the short way round. */
  protected abstract lerpRotation(a: D["rot"], b: D["rot"], alpha: number): D["rot"];
  protected abstract poseDiffers(a: Pose<D>, b: Pose<D>): boolean;
  protected abstract bodySettings(rb: T["body"]): BodySettings;
  /** The velocity, angular velocity (radians), force and torque scripts left for the coming step; cleared as they're taken. */
  protected abstract takePending(rb: T["body"]): { velocity: number[] | null; angularVelocity: number[] | null; force: number[]; torque: number[] };
  /** The collider's signature (rebuilt when it changes) and what its shape is built from; null while it can't be built yet (a mesh loading). */
  protected abstract colliderSource(c: T["collider"], active: boolean): { signature: string; scale: readonly number[]; source?: readonly unknown[] | null } | null;
  protected abstract colliderShape(c: T["collider"], scale: readonly number[], body: T["body"] | null, source: readonly unknown[] | null | undefined): D["shape"];
  /** World pose of the collider's shape (node pose plus its turned, scaled offset). */
  protected abstract colliderWorldPose(c: T["collider"], scale?: readonly number[]): Pose<D>;
  /** Fields of the anchors, for the joint's signature. */
  protected abstract jointAnchorSignature(j: T["joint"]): unknown[];
  /** The joint's description between `p1` (its body's pose) and `p2` (the connected body's, or the ground's). */
  protected abstract jointDesc(j: T["joint"], p1: Pose<D>, p2: Pose<D>, connected: T["body"] | null): { desc: Omit<JointDesc<D>, "body1" | "body2" | "contacts">; local1: D["vec"]; local2: D["vec"]; restAngle: number };
  /** The settings to apply to a live joint, or null when it has none. */
  protected abstract jointSettings(j: T["joint"], st: JointState<D, T["body"]>): JointSettings | null;
  protected abstract characterSettings(cc: T["character"]): CharacterSettings;
  /** Move a character's node by `movement` from its shape's position `start`. */
  protected abstract moveNode(cc: T["character"], start: D["vec"], movement: D["vec"]): void;
  /** Where point `p` goes when a body moves from pose `from` to `to`, less `p`. */
  protected abstract carried(from: Pose<D>, to: Pose<D>, p: D["vec"]): D["vec"];
  /** The hit an `onControllerColliderHit` gets (Vector2 or Vector3 fields). */
  protected abstract controllerHit(cc: T["character"], other: T["collider"], point: D["vec"], normal: D["vec"], direction: number[], moveLength: number): T["hit"];
  protected abstract movement(v: D["vec"]): T["movement"];

  constructor(
    protected readonly world: World,
    backend: { capabilities: PhysicsCapabilities; createWorld(o: { gravity: D["vec"]; warn(key: string, message: string): void }): PhysicsWorldBackend<D> },
    gravity: D["vec"],
  ) {
    this.capabilities = backend.capabilities;
    this.backend = backend.createWorld({ gravity, warn: (key, message) => this.warnOnce(key, message) });
    this.layerGroups = layerGroups(world.settings.physics);
  }

  readonly capabilities: PhysicsCapabilities;

  get gravity(): D["vec"] {
    return this.backend.gravity;
  }
  set gravity(g: D["vec"]) {
    this.backend.gravity = g;
  }

  /** @internal Dispose: the backend world is freed. */
  free(): void {
    this.backend.free();
  }

  protected warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[myco] ${message}`);
  }

  /** Layer name → collision groups (membership in the high 16 bits, filter in the low 16). */
  protected groupsFor(layer: string): number {
    const g = this.layerGroups.get(layer);
    if (g === undefined) {
      const first = this.world.settings.physics.layers[0];
      this.warnOnce(`layer:${layer}`, `unknown physics layer "${layer}"; using "${first}".`);
      return this.layerGroups.get(first)!;
    }
    return g;
  }

  /** A query's filter: colliders on any of `layers` (undefined: all). */
  protected queryGroups(layers?: string[]): number | undefined {
    if (!layers?.length) return undefined;
    return (0xffff << 16) | layers.reduce((m, l) => m | (this.groupsFor(l) >>> 16), 0);
  }

  protected arr(v: D["vec"] | D["ang"]): number[] {
    if (typeof v === "number") return [v];
    const o = v as { x: number; y: number; z?: number };
    return o.z === undefined ? [o.x, o.y] : [o.x, o.y, o.z];
  }

  // --- fixed-step stages (the plugin's systems) ----------------------------------------------------

  /** @internal Transforms and Component changes → the backend, before the step. */
  push(): void {
    for (const rb of this.world._componentsOfType(this.Body)) this.pushBody(rb);
    for (const c of this.world._componentsOfType(this.Collider)) this.pushCollider(c);
    for (const j of this.world._componentsOfType(this.Joint)) this.pushJoint(j);
    this.findPlatforms();
  }

  /** @internal */
  step(dt: number): void {
    this.dt = dt;
    this.backend.step(dt);
  }

  /** @internal The step's results → Transforms (dynamic bodies), and characters carried by platforms. */
  writeBack(): void {
    this.carryOnPlatforms();
    for (const rb of this.world._componentsOfType(this.Body)) {
      const st = rb._state;
      if (!st || !st.active || rb.bodyType !== "dynamic") continue;
      if (st.body.isSleeping()) {
        if (st.curr) st.prev = st.curr; // at rest: nothing left to blend
        continue;
      }
      const t = rb.node.transform;
      if (!t) continue;
      const pose = st.body.pose();
      if (rb.interpolate) {
        st.prev = st.curr ?? pose;
        st.curr = pose;
      } else {
        st.prev = st.curr = null;
      }
      this.writePose(t, pose);
      st.interpolated = false;
      st.syncedVersion = this.world.tVersion[rb.node.entity];
    }
  }

  /**
   * @internal Interpolation (ADR 0093), in Worlds that render: show each interpolating dynamic body
   * `alpha` of the way from its pose before the last step to its pose after it.
   */
  interpolate(alpha: number): void {
    for (const rb of this.world._componentsOfType(this.Body)) {
      const st = rb._state;
      if (!st?.prev || !st.curr || !st.active || !rb.interpolate || rb.bodyType !== "dynamic") continue;
      const t = rb.node.transform;
      if (!t || this.world.tVersion[rb.node.entity] !== st.syncedVersion) continue; // a script moved it: that wins
      const a = st.prev, b = st.curr;
      if (a === b && !st.interpolated) continue; // at rest and already showing it
      const pa = this.arr(a.position), pb = this.arr(b.position);
      this.writePose(t, { position: this.vec(pa.map((v, i) => v + (pb[i] - v) * alpha)), rotation: this.lerpRotation(a.rotation, b.rotation, alpha) });
      st.interpolated = true;
      st.syncedVersion = this.world.tVersion[rb.node.entity];
    }
  }

  /** @internal Before a fixed step's scripts: put interpolated bodies back at their simulated pose. */
  restoreInterpolated(): void {
    for (const rb of this.world._componentsOfType(this.Body)) {
      const st = rb._state;
      if (!st?.interpolated || !st.curr) continue;
      st.interpolated = false;
      const t = rb.node.transform;
      if (!t || this.world.tVersion[rb.node.entity] !== st.syncedVersion) continue;
      this.writePose(t, st.curr);
      st.syncedVersion = this.world.tVersion[rb.node.entity];
    }
  }

  // --- bodies --------------------------------------------------------------------------------------

  protected pushBody(rb: T["body"]): void {
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
    const settings = this.bodySettings(rb);
    const sig = JSON.stringify(settings);
    if (sig !== st.signature) {
      this.configureBody(body, settings);
      st.signature = sig;
    }
    const e = rb.node.entity;
    const version = this.world.tVersion[e];
    if (rb.node.transform && version !== st.syncedVersion) {
      const pose = this.nodePose(rb.node);
      if (rb.bodyType === "kinematic") {
        body.moveKinematic(pose);
      } else {
        // A static body moved, or a script teleported a dynamic one.
        body.teleport(pose);
        st.prev = st.curr = null; // teleported: nothing to blend from
      }
      st.interpolated = false;
      st.syncedVersion = version;
    }
    const pending = this.takePending(rb);
    if (pending.velocity) body.setLinearVelocity(this.vec(pending.velocity));
    if (pending.angularVelocity) body.setAngularVelocity(this.ang(pending.angularVelocity));
    // "force" mode applies for exactly one step (Unity semantics).
    st.lastForce = pending.force;
    st.lastTorque = pending.torque;
    body.setStepForce(this.vec(pending.force), this.ang(pending.torque));
  }

  private configureBody(body: BackendBody<D>, settings: BodySettings): void {
    if (settings.ccd && !this.capabilities.continuousCollision) this.warnOnce("ccd", "this physics backend has no continuous collision detection; bodies use discrete collision.");
    body.configure(settings);
  }

  private createBody(rb: T["body"]): BodyState<D> {
    const pose = rb.node.transform ? this.nodePose(rb.node) : { position: this.vec([0, 0, 0]), rotation: this.identity };
    const settings = this.bodySettings(rb);
    const body = this.backend.createBody(rb.bodyType, pose, null);
    this.configureBody(body, settings);
    return { body, signature: JSON.stringify(settings), syncedVersion: this.world.tVersion[rb.node.entity], active: true, prev: null, curr: null, interpolated: false, lastForce: [0, 0, 0], lastTorque: [0, 0, 0] };
  }

  // --- colliders -----------------------------------------------------------------------------------

  /** A dimension's own collider kinds (2D tilemap colliders) handled outside the common path: true when handled. */
  protected pushSpecialCollider(_c: T["collider"]): boolean {
    return false;
  }

  protected pushCollider(c: T["collider"]): void {
    if (this.pushSpecialCollider(c)) return;
    const active = c.isActiveAndEnabled;
    const body = active ? c.attachedRigidbody : null;
    const e = c.node.entity;
    const src = this.colliderSource(c, active);
    if (!src) return; // can't be built yet
    let st = c._state;
    const sourceChanged = !!st && !!src.source && (st.source?.length !== src.source.length || src.source.some((m, i) => st!.source![i] !== m));
    if (st && (st.body !== body || st.signature !== src.signature || (body && !body._state) || sourceChanged)) {
      this.releaseCollider(c);
      st = null;
    }
    if (!st) {
      if (!active) return;
      if (body && !body._state) return; // its body is created in the same pass, earlier
      st = c._state = this.createCollider(c, body, src);
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
        const local = this.poseInBody(c, body, src.scale);
        if (!st.local || this.poseDiffers(local, st.local)) {
          st.collider.setLocalPose(local);
          st.local = local;
        }
        st.syncedVersion = version;
      }
      return;
    }
    // Without a body: follow the Transform when it changes.
    if (version !== st.syncedVersion && st.ownBody) {
      st.ownBody.place(this.colliderWorldPose(c, src.scale).position);
      st.syncedVersion = version;
    } else if (version !== st.syncedVersion) {
      st.collider.setPose(this.colliderWorldPose(c, src.scale));
      st.syncedVersion = version;
    }
  }

  private createCollider(c: T["collider"], body: T["body"] | null, src: { signature: string; scale: readonly number[]; source?: readonly unknown[] | null }): ColliderState<D, T["body"]> {
    const shape = this.colliderShape(c, src.scale, body, src.source);
    let local: Pose<D> | null = null;
    let ownBody: BackendBody<D> | undefined;
    let pose: Pose<D>;
    if (c instanceof this.Character) {
      // On its own kinematic body, so it meets static triggers and level geometry (static–static pairs never do).
      ownBody = this.backend.createBody("kinematic", { position: this.colliderWorldPose(c, src.scale).position, rotation: this.identity }, null);
      pose = { position: this.vec([0, 0, 0]), rotation: this.identity };
    } else if (body?._state) {
      // Placed relative to the body, in the body's turned frame.
      pose = local = this.poseInBody(c, body, src.scale);
    } else {
      pose = this.colliderWorldPose(c, src.scale);
    }
    const collider = this.backend.createCollider({
      shape,
      pose,
      parent: ownBody ?? body?._state?.body ?? null,
      sensor: c.isTrigger,
      friction: c.material?.friction ?? 0.5,
      restitution: c.material?.bounciness ?? 0,
      groups: this.groupsFor(c.layer),
    });
    this.colliderById.set(collider.id, c);
    return { collider, body, signature: src.signature, syncedVersion: this.world.tVersion[c.node.entity], active: true, local, ownBody, source: src.source ?? null };
  }

  /**
   * The collider's shape pose in its body's frame, from the two nodes' Transforms (not the backend's
   * body, whose pose an interpolated Transform may lag behind; the two nodes lag together).
   */
  protected poseInBody(c: T["collider"], body: T["body"], scale: readonly number[]): Pose<D> {
    const b = body.node.transform ? this.nodePose(body.node) : { position: this.vec([0, 0, 0]), rotation: this.identity };
    return this.relativePose(b, this.colliderWorldPose(c, scale));
  }

  /** The body a collider's hooks also run on. */
  protected colliderBody(c: T["collider"]): T["body"] | null {
    return c._state?.body ?? null;
  }

  // --- joints (ADR 0092) ---------------------------------------------------------------------------

  protected pushJoint(j: T["joint"]): void {
    if (j._broken) return;
    const active = j.isActiveAndEnabled;
    const body = active ? j.body : null;
    const connected = active ? j.connectedRigidbody : null;
    if (active && !body) this.warnOnce(`jointbody:${j.node.entity}`, `${j.node.name}: ${j.constructor.name} needs a ${this.bodyName} on its node or above it.`);
    if (active && j.connectedBody?.isValid && !connected) this.warnOnce(`jointother:${j.node.entity}`, `${j.node.name}: ${j.constructor.name}'s connected node "${j.connectedBody.name}" has no ${this.bodyName}.`);
    const signature = [j._jointSignature(), ...this.jointAnchorSignature(j), j.connectedBody?.isValid ? j.connectedBody.entity : -1, j.enableCollision].join("|");
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
      const s = this.jointSettings(j, st);
      if (s) {
        if (s.motor && !this.capabilities.jointMotors) this.warnOnce("motors", "this physics backend has no joint motors; motors and springs are off.");
        st.joint.configure(this.capabilities.jointMotors ? s : { ...s, motor: null, spring: null });
        st.body._state?.body.wakeUp();
      }
    }
    // Breakable: measure whichever body is dynamic across the step (backends don't all report joint forces).
    st.measure = null;
    if (j.breakForce > 0 || j.breakTorque > 0) {
      const own = st.body.bodyType === "dynamic";
      const rb = own ? st.body : st.connected?.bodyType === "dynamic" ? st.connected : null;
      const b = rb?._state?.body;
      if (rb && b) st.measure = { rb, local: own ? st.local1 : st.local2, v0: b.linearVelocity(), w0: b.angularVelocity() };
    }
  }

  private createJoint(j: T["joint"], body: T["body"], connected: T["body"] | null, signature: string): JointState<D, T["body"]> {
    const p1 = body.node.transform ? this.nodePose(body.node) : { position: this.vec([0, 0, 0]), rotation: this.identity };
    let b2: BackendBody<D>, ground: BackendBody<D> | null = null, p2 = p1;
    if (connected) {
      b2 = connected._state!.body;
      p2 = connected.node.transform ? this.nodePose(connected.node) : { position: this.vec([0, 0, 0]), rotation: this.identity };
    } else {
      // The world: a fixed body where this body is now, so the two frames start out matching.
      ground = b2 = this.backend.createBody("static", p1, null);
    }
    const { desc, local1, local2, restAngle } = this.jointDesc(j, p1, p2, connected);
    // The backend's first body is the connected one, so angles and positions read as this body's relative to it.
    const joint = this.backend.createJoint({ ...desc, body1: b2, body2: body._state!.body, contacts: j.enableCollision } as JointDesc<D>);
    return { joint, signature, settings: "", body, connected, ground, restAngle, local1, local2, measure: null };
  }

  /**
   * After a step: estimate each breakable joint's force and torque from its body's change in momentum,
   * less gravity, damping, scripted forces and contact impulses, and break it past its limits.
   * With several joints on one body, each sees their total. Contact friction isn't subtracted.
   */
  private checkJointBreaks(): void {
    const dt = this.dt;
    if (!(dt > 0)) return;
    for (const j of this.world._componentsOfType(this.Joint)) {
      const st = j._state, m0 = st?.measure;
      if (!st || !m0) continue;
      st.measure = null;
      const { rb, local } = m0;
      const bst = rb._state;
      const b = bst?.body;
      if (!b || !bst.active) continue;
      const mass = Math.max(rb.mass, 1e-4), inertia = mass / 6;
      const v0 = this.arr(m0.v0), w0 = this.arr(m0.w0), v1 = this.arr(b.linearVelocity()), w1 = this.arr(b.angularVelocity());
      const g = this.arr(this.backend.gravity), gs = rb.useGravity ? rb.gravityScale : 0;
      const F = v1.map((v, i) => (mass * (v - v0[i])) / dt - mass * g[i] * gs - (bst.lastForce[i] ?? 0) + mass * rb.drag * v);
      const T = w1.map((w, i) => (inertia * (w - w0[i])) / dt - (bst.lastTorque[i] ?? 0) + inertia * rb.angularDrag * w);
      const pose = b.pose();
      const com = this.arr(pose.position);
      // Contacts on the body's colliders push it too.
      for (const c of this.world._componentsOfType(this.Collider)) {
        const col = c._state?.body === rb ? c._state.collider : null;
        if (!col) continue;
        for (const { impulse, point } of this.backend.contactImpulses(col)) {
          const f = this.arr(impulse).map((v) => v / dt);
          f.forEach((v, i) => (F[i] -= v));
          if (point) cross(this.arr(point).map((v, i) => v - com[i]), f).forEach((v, i) => (T[i] -= v));
        }
      }
      // The joint's own force, applied at the anchor, turns the body too: what's left is the joint's torque.
      cross(this.rotate(pose.rotation, this.arr(local)), F).forEach((v, i) => (T[i] -= v));
      const force = Math.hypot(...F), torque = Math.hypot(...T);
      if ((j.breakForce > 0 && force > j.breakForce) || (j.breakTorque > 0 && torque > j.breakTorque)) this.breakJoint(j, force, torque);
    }
  }

  private breakJoint(j: T["joint"], force: number, torque: number): void {
    this.releaseJoint(j);
    j._broken = true;
    for (const comp of [...this.world._componentsOf(j.node.entity)]) {
      if (!(comp instanceof GameBehavior) || !comp.isActiveAndEnabled || !comp.onJointBreak) continue;
      try {
        comp.onJointBreak(j, force, torque);
      } catch (err) {
        console.error(`[myco] ${comp.constructor.name}.onJointBreak threw:`, err);
      }
    }
    GameObject.destroy(j);
  }

  // --- events (ADR 0017, 0093) ---------------------------------------------------------------------

  /** Pairs of colliders touching (or overlapping, for triggers) since an earlier step, for `Stay` hooks. */
  private readonly touching = new Map<string, { id1: number; id2: number; fresh: boolean }>();

  /** @internal After the step: joint breaks, then contact events to buffers and hooks. */
  dispatchEvents(): void {
    this.checkJointBreaks();
    this.backend.drainCollisionEvents((id1, id2, started) => {
      const key = id1 < id2 ? `${id1}:${id2}` : `${id2}:${id1}`;
      if (started) this.touching.set(key, { id1, id2, fresh: true });
      else this.touching.delete(key);
      const a = this.colliderById.get(id1), b = this.colliderById.get(id2);
      if (!a || !b || a._destroyed || b._destroyed) return;
      const trigger = a.isTrigger || b.isTrigger;
      this.world._buffer(trigger ? this.triggerEvents : this.collisionEvents).push({ a, b, started }); // this World's, whichever is current
      this.notify(a, b, trigger, started ? "Enter" : "Exit");
      this.notify(b, a, trigger, started ? "Enter" : "Exit");
    });
    // onCollisionStay / onTriggerStay: every step after the one that began the contact, while it lasts.
    for (const [key, pair] of this.touching) {
      if (pair.fresh) {
        pair.fresh = false;
        continue;
      }
      const a = this.colliderById.get(pair.id1), b = this.colliderById.get(pair.id2);
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
  private notify(self: T["collider"], other: T["collider"], trigger: boolean, phase: Hook): void {
    const nodes = new Set([self.node.entity, self.owner.entity]);
    const body = this.colliderBody(self);
    if (body?.node.isValid) nodes.add(body.node.entity);
    const hook = `${trigger ? "onTrigger" : "onCollision"}${phase}`;
    const collision = trigger ? null : { collider: other, otherCollider: self, gameObject: other.owner, rigidbody: other._state?.body ?? null };
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

  /** Forget a collider's touching pairs (it's going away). */
  protected forgetContacts(id: number): void {
    for (const [key, pair] of this.touching) if (pair.id1 === id || pair.id2 === id) this.touching.delete(key);
  }

  // --- character controllers and moving platforms (ADR 0091) ---------------------------------------

  private readonly controllers = new Map<T["character"], { kcc: BackendCharacter<D>; settings: string }>();

  /** @internal Move a character controller by `motion`, sliding along what it hits; null before its collider exists. */
  moveCharacter(cc: T["character"], motion: D["vec"]): { movement: T["movement"]; flags: CollisionFlags; hits: T["hit"][] } | null {
    const st = cc._state;
    if (!st || !st.active || !cc.node.transform) return null;
    if (!this.capabilities.characterController) {
      this.warnOnce("cc", "this physics backend has no character controller; character controllers move without colliding.");
      return null;
    }
    let entry = this.controllers.get(cc);
    if (!entry) this.controllers.set(cc, (entry = { kcc: this.backend.createCharacter(), settings: "" }));
    const settings = cc._settingsSignature();
    if (entry.settings !== settings) {
      entry.settings = settings;
      entry.kcc.configure(this.characterSettings(cc));
    }
    // Start from where the node is now (a script may have moved it since the last push).
    const start = this.colliderWorldPose(cc).position;
    const own = st.ownBody!;
    own.place(start);
    const result = entry.kcc.move(st.collider, motion, this.groupsFor(cc.layer));
    const s = this.arr(start), m = this.arr(result.movement);
    own.place(this.vec(s.map((v, i) => v + m[i])));
    this.moveNode(cc, start, result.movement);
    st.syncedVersion = this.world.tVersion[cc.node.entity];

    const mo = this.arr(motion);
    const len = Math.hypot(...mo);
    const dir = len > 0 ? mo.map((v) => v / len) : mo.map(() => 0);
    const cosSlope = Math.cos((cc.slopeLimit * Math.PI) / 180);
    let below = result.grounded, sides = false, above = false;
    const hits: T["hit"][] = [];
    for (const hit of result.hits) {
      const other = this.colliderById.get(hit.collider);
      if (!other || other._destroyed) continue;
      const ny = this.arr(hit.normal)[1];
      if (ny >= cosSlope - 1e-3) below = true;
      else if (ny <= -cosSlope) above = true;
      else sides = true;
      hits.push(this.controllerHit(cc, other, hit.point, hit.normal, dir, Math.hypot(...this.arr(hit.applied))));
    }
    return { movement: this.movement(result.movement), flags: { below, sides, above }, hits };
  }

  /** Grounded character controllers standing on a moving body, with that body's pose before the step. */
  private platforms: { cc: T["character"]; body: BackendBody<D>; pose: Pose<D> }[] = [];

  /** Before the step: what each grounded controller stands on, if it's a body that can move. */
  private findPlatforms(): void {
    this.platforms.length = 0;
    for (const cc of this.controllers.keys()) {
      if (!cc.isGrounded || !cc.moveWithPlatforms || !cc.isActiveAndEnabled) continue;
      const st = cc._state;
      if (!st?.ownBody) continue;
      const reach = Math.max(cc.skinWidth, 1e-3) + Math.max(cc.snapToGround, 0) + 0.05;
      const body = this.backend.castCollider(st.collider, this.down, reach, this.groupsFor(cc.layer), st.ownBody)?.body;
      if (!body || body.isFixed()) continue;
      this.platforms.push({ cc, body, pose: body.pose() });
    }
  }

  /** After the step: move each controller with the platform under it (sliding along anything in the way). */
  private carryOnPlatforms(): void {
    for (const { cc, body, pose } of this.platforms) {
      if (!cc._state || body.removed) continue;
      const delta = this.carried(pose, body.pose(), this.colliderWorldPose(cc).position);
      if (Math.hypot(...this.arr(delta)) < 1e-7) continue;
      const flags = cc._flags;
      this.moveCharacter(cc, delta);
      cc._flags = flags; // still standing on it
    }
    this.platforms.length = 0;
  }

  // --- queries -------------------------------------------------------------------------------------

  /** @internal */
  raycast(origin: D["vec"], dir: D["vec"], maxDistance: number, layers?: string[]): { collider: T["collider"]; point: D["vec"]; normal: D["vec"]; distance: number } | null {
    const d = this.arr(dir);
    const len = Math.hypot(...d) || 1;
    const hit = this.backend.raycast(origin, this.vec(d.map((v) => v / len)), maxDistance, this.queryGroups(layers));
    const collider = hit ? this.colliderById.get(hit.collider) : undefined;
    return hit && collider ? { collider, point: hit.point, normal: hit.normal, distance: hit.distance } : null;
  }

  /** @internal Sweep a shape along `direction`; the first collider hit, or null. */
  castShape(shape: D["queryShape"], position: D["vec"], rotation: D["rot"], direction: D["vec"], maxDistance: number, layers?: string[]): { collider: T["collider"]; point: D["vec"]; normal: D["vec"]; distance: number } | null {
    const d = this.arr(direction);
    const len = Math.hypot(...d) || 1;
    const hit = this.backend.castShape(shape, position, rotation, this.vec(d.map((v) => v / len)), maxDistance, this.queryGroups(layers));
    const collider = hit ? this.colliderById.get(hit.collider) : undefined;
    return hit && collider ? { collider, point: hit.point, normal: hit.normal, distance: hit.distance } : null;
  }

  /** @internal Every collider intersecting the shape. */
  overlap(shape: D["queryShape"], position: D["vec"], rotation: D["rot"], layers?: string[]): T["collider"][] {
    return this.collidersOf(this.backend.overlap(shape, position, rotation, this.queryGroups(layers)));
  }

  /** @internal Every collider containing the point. */
  overlapPoint(point: D["vec"], layers?: string[]): T["collider"][] {
    return this.collidersOf(this.backend.overlapPoint(point, this.queryGroups(layers)));
  }

  private collidersOf(ids: number[]): T["collider"][] {
    const found = new Set<T["collider"]>();
    for (const id of ids) {
      const c = this.colliderById.get(id);
      if (c) found.add(c);
    }
    return [...found];
  }

  // --- release -------------------------------------------------------------------------------------

  /** Release a dimension's own collider kinds attached to `rb` (it's going away). */
  protected releaseSpecialFor(_rb: T["body"]): void {}

  /** @internal */
  releaseBody(rb: T["body"]): void {
    const st = rb._state;
    if (!st) return;
    // Colliders attached to this body go with it; they are recreated (as static or on another body) next push.
    for (const c of this.world._componentsOfType(this.Collider)) if (c._state?.body === rb) this.releaseCollider(c);
    this.releaseSpecialFor(rb);
    for (const j of this.world._componentsOfType(this.Joint)) if (j._state && (j._state.body === rb || j._state.connected === rb)) this.releaseJoint(j);
    this.backend.removeBody(st.body);
    rb._state = null;
  }

  /** Release a dimension's own collider kind (a tilemap collider): true when it was one. */
  protected releaseSpecialCollider(_c: T["collider"]): boolean {
    return false;
  }

  /** @internal */
  releaseCollider(c: T["collider"]): void {
    if (this.releaseSpecialCollider(c)) return;
    const st = c._state;
    if (!st) return;
    const id = st.collider.id;
    this.colliderById.delete(id);
    if (c instanceof this.Character) {
      const entry = this.controllers.get(c);
      if (entry) this.backend.removeCharacter(entry.kcc);
      this.controllers.delete(c);
    }
    this.forgetContacts(id);
    this.backend.removeCollider(st.collider);
    if (st.ownBody) this.backend.removeBody(st.ownBody);
    c._state = null;
  }

  /** @internal */
  releaseJoint(j: T["joint"]): void {
    const st = j._state;
    if (!st) return;
    this.backend.removeJoint(st.joint);
    if (st.ground) this.backend.removeBody(st.ground);
    j._state = null;
  }
}

/** The cross product of 2D (a scalar, as one number) or 3D vectors. */
function cross(a: readonly number[], b: readonly number[]): number[] {
  if (a.length === 2) return [a[0] * b[1] - a[1] * b[0]];
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
