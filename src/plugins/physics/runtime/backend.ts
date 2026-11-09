/**
 * The physics backend contribution point (ADR 0137): what a backend plugin (Rapier, later Box2D or Jolt)
 * gives the Physics plugin, per dimension. The Physics plugin's shared sync core (`core/`) reads the
 * Components and drives a backend through these neutral descriptions; nothing here names a backend's own
 * types (ADR 0010). Vectors and rotations are plain objects in world units; angles are radians.
 *
 * A backend plugin depends on `myco.physics` and contributes through its runtime context:
 *
 * ```ts
 * context.contribute(PHYSICS_BACKENDS, { id: "rapier", dimension: "2d", load: () => import("./rapier2d").then((m) => m.backend()) });
 * ```
 *
 * A World uses the backend the project names (`physics.backend2d`, `physics.backend3d`), or the only one
 * registered for its dimension. With none, physics Components stay inert and the World warns once.
 */
import type { BodyType } from "../../../engine/physics/types";
import type { World } from "../../../engine/core/World";
import type { ContributionPoint } from "../../runtimeContext";

// --- Neutral value types ------------------------------------------------------------------------

export interface Vec2 {
  x: number;
  y: number;
}
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}
/** A point in a 2D shape's local plane, `[x, y]`. */
export type Point2 = readonly [number, number];

/** 2D shapes, in the collider's frame. */
export type ShapeDesc2D =
  | { readonly kind: "box"; readonly halfExtents: Vec2 }
  | { readonly kind: "circle"; readonly radius: number }
  /** Upright (along y); `halfHeight` is the straight part's. */
  | { readonly kind: "capsule"; readonly radius: number; readonly halfHeight: number }
  /** A polygon split into convex parts (one part: a convex hull). If a part has no hull, the closed `outline` collides as a line. */
  | { readonly kind: "convexPolygons"; readonly parts: readonly (readonly Point2[])[]; readonly outline: readonly Point2[]; readonly label?: string }
  /** The convex hull of the points (a tiny circle when they have none). */
  | { readonly kind: "convexHull"; readonly points: readonly Point2[] }
  /** A line through the points; closed shapes repeat the first point. Oriented lines are solid on their left only. */
  | { readonly kind: "polyline"; readonly points: readonly Point2[]; readonly oriented?: boolean }
  /** Several shapes as one collider; `fixInternalEdges` keeps bodies sliding over the seams from catching. */
  | { readonly kind: "compound"; readonly parts: readonly { readonly shape: ShapeDesc2D; readonly offset: Vec2 }[]; readonly fixInternalEdges?: boolean };

/** 3D shapes, in the collider's frame. */
export type ShapeDesc3D =
  | { readonly kind: "box"; readonly halfExtents: Vec3 }
  | { readonly kind: "sphere"; readonly radius: number }
  /** Along y; `halfHeight` is the straight part's. */
  | { readonly kind: "capsule"; readonly radius: number; readonly halfHeight: number }
  /** Triangles (`indices` into `vertices`, xyz triples). `convex` wraps them in their hull, falling back to the triangles (with a warning) when flat. */
  | { readonly kind: "mesh"; readonly vertices: Float32Array; readonly indices: Uint32Array; readonly convex: boolean; readonly label?: string };

/* `label` names what the shape is for (a node) in the backend's warnings. */

/** Shapes for casts and overlap queries. */
export type QueryShape2D = { kind: "circle"; radius: number } | { kind: "box"; halfExtents: Vec2 } | { kind: "capsule"; radius: number; halfHeight: number };
export type QueryShape3D = { kind: "sphere"; radius: number } | { kind: "box"; halfExtents: Vec3 } | { kind: "capsule"; radius: number; halfHeight: number };

/** Joints between two bodies: `body1` is the connected body (or a fixed one standing in for the world), `body2` the joint's own. */
export type JointKind2D = "fixed" | "revolute" | "prismatic" | "rope" | "spring";
export type JointKind3D = "fixed" | "revolute" | "prismatic" | "spherical" | "rope" | "spring";

/** Limits, motor and spring on a live joint; radians for angles. Null parts are off. */
export interface JointSettings {
  readonly limits: readonly [number, number] | null;
  /** Drive towards `targetVelocity` with at most `maxForce`. */
  readonly motor: { readonly targetVelocity: number; readonly maxForce: number } | null;
  /** Pull towards `target` with `stiffness` and `damping`. Ignored while a motor is on. */
  readonly spring: { readonly target: number; readonly stiffness: number; readonly damping: number } | null;
  /** A spherical joint's twist range (around its x axis) and swing cone half-angle. */
  readonly cone?: { readonly twist: readonly [number, number]; readonly swing: number } | null;
}

// --- Per-dimension type bundles ------------------------------------------------------------------

/** The types that differ between 2D and 3D, so one interface describes both backends. */
export interface DimensionTypes {
  vec: Vec2 | Vec3;
  rot: number | Quat;
  /** Angular velocity and torque: radians per second around z (2D), or around each axis (3D). */
  ang: number | Vec3;
  shape: ShapeDesc2D | ShapeDesc3D;
  queryShape: QueryShape2D | QueryShape3D;
  jointKind: string;
}
export interface Dim2 extends DimensionTypes {
  vec: Vec2;
  rot: number;
  ang: number;
  shape: ShapeDesc2D;
  queryShape: QueryShape2D;
  jointKind: JointKind2D;
}
export interface Dim3 extends DimensionTypes {
  vec: Vec3;
  rot: Quat;
  ang: Vec3;
  shape: ShapeDesc3D;
  queryShape: QueryShape3D;
  jointKind: JointKind3D;
}

export interface Pose<D extends DimensionTypes> {
  readonly position: D["vec"];
  readonly rotation: D["rot"];
}

/** A body's simulation settings. Locks are per axis: translations x, y(, z); rotations: one (2D) or x, y, z (3D). */
export interface BodySettings {
  readonly type: BodyType;
  readonly mass: number;
  /** Mass-like inertia around each rotation axis. */
  readonly inertia: number;
  readonly gravityScale: number;
  readonly linearDamping: number;
  readonly angularDamping: number;
  readonly lockTranslation: readonly boolean[];
  readonly lockRotation: readonly boolean[];
  /** Continuous collision detection (capability `continuousCollision`). */
  readonly ccd: boolean;
}

export interface BackendBody<D extends DimensionTypes> {
  /** True once the backend world no longer has it. */
  readonly removed: boolean;
  pose(): Pose<D>;
  /** Move it there at once (a dynamic or static body teleporting). */
  teleport(pose: Pose<D>): void;
  /** A kinematic body's target for the next step. */
  moveKinematic(pose: Pose<D>): void;
  /** Put a kinematic body at `position` now and as its target, with its colliders updated for queries at once. */
  place(position: D["vec"]): void;
  configure(settings: BodySettings): void;
  setEnabled(on: boolean): void;
  isSleeping(): boolean;
  isFixed(): boolean;
  wakeUp(): void;
  linearVelocity(): D["vec"];
  setLinearVelocity(v: D["vec"]): void;
  angularVelocity(): D["ang"];
  setAngularVelocity(w: D["ang"]): void;
  applyImpulse(impulse: D["vec"]): void;
  applyTorqueImpulse(impulse: D["ang"]): void;
  /** The force and torque for the coming step only (replacing the last ones). */
  setStepForce(force: D["vec"], torque: D["ang"]): void;
}

export interface ColliderDesc<D extends DimensionTypes> {
  readonly shape: D["shape"];
  /** Relative to `parent`, or in world space without one. */
  readonly pose: Pose<D>;
  /** The body carrying it (its mass comes from the body's settings, not the shape), or null for a static collider. */
  readonly parent: BackendBody<D> | null;
  readonly sensor: boolean;
  readonly friction: number;
  readonly restitution: number;
  /** Collision groups: layer membership in the high 16 bits, the layers it meets in the low 16 (`physics/layers.ts`). */
  readonly groups: number;
  /** 2D, capability `oneWayPlatforms`: collide only with bodies coming down onto it from above `top` along `up` (`base`: its own height along `up` when made). */
  readonly oneWay?: { readonly up: Vec2; readonly top: number; readonly base: number } | null;
}

export interface BackendCollider<D extends DimensionTypes> {
  /** Unique in its backend world: events and queries name colliders by it. */
  readonly id: number;
  setEnabled(on: boolean): void;
  /** Relative to its parent body. */
  setLocalPose(pose: Pose<D>): void;
  /** In world space (a collider without a body). */
  setPose(pose: Pose<D>): void;
}

export interface JointDesc<D extends DimensionTypes> {
  readonly kind: D["jointKind"];
  readonly body1: BackendBody<D>;
  readonly body2: BackendBody<D>;
  /** The joint's anchor in each body's frame. */
  readonly anchor1: D["vec"];
  readonly anchor2: D["vec"];
  /** The joint's frame in each body's frame (3D: its x axis is the hinge or slider axis; 2D fixed joints: the angle between the bodies). */
  readonly frame1?: D["rot"];
  readonly frame2?: D["rot"];
  /** 2D prismatic joints: the axis in body1's frame. */
  readonly axis?: D["vec"];
  /** Rope: its longest; spring: its rest length. */
  readonly length?: number;
  readonly stiffness?: number;
  readonly damping?: number;
  /** Revolute and prismatic limits when made. */
  readonly limits?: readonly [number, number] | null;
  /** Whether the two bodies' colliders collide. */
  readonly contacts: boolean;
}

export interface BackendJoint {
  configure(settings: JointSettings): void;
}

export interface CharacterSettings {
  /** The gap kept from what it touches. */
  readonly offset: number;
  /** Radians. */
  readonly slopeLimit: number;
  readonly autostep: { readonly height: number; readonly minWidth: number } | null;
  readonly snapToGround: number | null;
  readonly pushBodies: boolean;
  readonly mass: number;
}

export interface CharacterHit<D extends DimensionTypes> {
  readonly collider: number;
  readonly point: D["vec"];
  readonly normal: D["vec"];
  /** How far the move had gone when it hit. */
  readonly applied: D["vec"];
}

/** A backend's character controller (capability `characterController`): computes how a collider can move, sliding along what it hits. */
export interface BackendCharacter<D extends DimensionTypes> {
  configure(settings: CharacterSettings): void;
  /** How far `collider` can move along `motion` (not moving it), ignoring sensors. Pushes dynamic bodies when configured to. */
  move(collider: BackendCollider<D>, motion: D["vec"], groups: number): { movement: D["vec"]; grounded: boolean; hits: CharacterHit<D>[] };
}

export interface RayHit<D extends DimensionTypes> {
  readonly collider: number;
  readonly point: D["vec"];
  readonly normal: D["vec"];
  readonly distance: number;
}

/** What a backend world can do beyond the basics. The core warns once and does without where one is missing. */
export interface PhysicsCapabilities {
  readonly characterController: boolean;
  readonly jointMotors: boolean;
  readonly continuousCollision: boolean;
  /** 2D one-way platforms (tilemap one-way tiles). */
  readonly oneWayPlatforms: boolean;
  /** 3D triangle-mesh colliders. */
  readonly meshColliders: boolean;
}

/** One World's simulation in a backend. */
export interface PhysicsWorldBackend<D extends DimensionTypes> {
  gravity: D["vec"];
  step(dt: number): void;
  free(): void;

  createBody(type: BodyType, pose: Pose<D>, settings: BodySettings | null): BackendBody<D>;
  removeBody(body: BackendBody<D>): void;
  createCollider(desc: ColliderDesc<D>): BackendCollider<D>;
  removeCollider(collider: BackendCollider<D>): void;
  createJoint(desc: JointDesc<D>): BackendJoint;
  removeJoint(joint: BackendJoint): void;
  createCharacter(): BackendCharacter<D>;
  removeCharacter(character: BackendCharacter<D>): void;

  /** Contact pairs that started or stopped since the last drain (triggers included). */
  drainCollisionEvents(fn: (collider1: number, collider2: number, started: boolean) => void): void;
  /** The impulses the last step's contacts gave `collider`'s body, each where it acted when known. */
  contactImpulses(collider: BackendCollider<D>): { impulse: D["vec"]; point: D["vec"] | null }[];

  /** `direction` is unit length; `groups` filters by layer (undefined: every collider). */
  raycast(origin: D["vec"], direction: D["vec"], maxDistance: number, groups?: number): RayHit<D> | null;
  castShape(shape: D["queryShape"], position: D["vec"], rotation: D["rot"], direction: D["vec"], maxDistance: number, groups?: number): RayHit<D> | null;
  /** Sweep `collider` (ignoring sensors, itself and `exclude`); the hit collider's body, if any. */
  castCollider(collider: BackendCollider<D>, direction: D["vec"], maxDistance: number, groups: number, exclude: BackendBody<D> | null): { collider: number; body: BackendBody<D> | null } | null;
  overlap(shape: D["queryShape"], position: D["vec"], rotation: D["rot"], groups?: number): number[];
  overlapPoint(point: D["vec"], groups?: number): number[];
}

export interface PhysicsWorldOptions<D extends DimensionTypes> {
  readonly gravity: D["vec"];
  /** Report a problem once per key (`[myco] …`). */
  warn(key: string, message: string): void;
}

/** A loaded backend for one dimension. */
export interface PhysicsBackend<D extends DimensionTypes> {
  readonly capabilities: PhysicsCapabilities;
  createWorld(options: PhysicsWorldOptions<D>): PhysicsWorldBackend<D>;
}
export type PhysicsBackend2D = PhysicsBackend<Dim2>;
export type PhysicsBackend3D = PhysicsBackend<Dim3>;
export type PhysicsWorld2DBackend = PhysicsWorldBackend<Dim2>;
export type PhysicsWorld3DBackend = PhysicsWorldBackend<Dim3>;

export type PhysicsDimension = "2d" | "3d";

/**
 * A backend a plugin contributes. `load` is a dynamic import, so the backend (and its WebAssembly) loads only when a
 * World needs it. `prefetch`, if given, fetches that code without starting it (the editor calls it once idle, ADR 0144).
 */
export type PhysicsBackendRegistration =
  | { readonly id: string; readonly dimension: "2d"; readonly title?: string; load(): Promise<PhysicsBackend2D>; prefetch?(): Promise<unknown> }
  | { readonly id: string; readonly dimension: "3d"; readonly title?: string; load(): Promise<PhysicsBackend3D>; prefetch?(): Promise<unknown> };

// --- The registry -------------------------------------------------------------------------------

const registry: PhysicsBackendRegistration[] = [];

/**
 * Add a backend; returns the undo. Plugins contribute through their runtime context instead
 * (`context.contribute(PHYSICS_BACKENDS, …)`), so deactivating the plugin removes it.
 */
export function registerPhysicsBackend(registration: PhysicsBackendRegistration): () => void {
  if (registry.some((r) => r.id === registration.id && r.dimension === registration.dimension)) throw new Error(`A ${registration.dimension} physics backend "${registration.id}" is already registered.`);
  registry.push(registration);
  return () => {
    const i = registry.indexOf(registration);
    if (i >= 0) registry.splice(i, 1);
  };
}

/** The registered backends for a dimension, in registration order. */
export function physicsBackends(dimension: PhysicsDimension): readonly PhysicsBackendRegistration[] {
  return registry.filter((r) => r.dimension === dimension);
}

/** The physics backend contribution point (ADR 0137), for `context.contribute`. */
export const PHYSICS_BACKENDS: ContributionPoint<PhysicsBackendRegistration> = { id: "myco.physics.backend", register: registerPhysicsBackend };

const warnedChoice = new WeakMap<World, Set<string>>();

/**
 * The backend a World uses for `dimension`: the one the project's `physics.backend2d`/`backend3d` names,
 * or the only one registered (with several and none named, the first, with a warning). Null when there is none.
 */
export function selectPhysicsBackend(world: World, dimension: PhysicsDimension): PhysicsBackendRegistration | null {
  const all = physicsBackends(dimension);
  const physics = world.settings.physics as { backend2d?: unknown; backend3d?: unknown };
  const named = dimension === "2d" ? physics.backend2d : physics.backend3d;
  const warn = (message: string) => {
    let seen = warnedChoice.get(world);
    if (!seen) warnedChoice.set(world, (seen = new Set()));
    if (seen.has(message)) return;
    seen.add(message);
    console.warn(`[myco] ${message}`);
  };
  if (typeof named === "string" && named) {
    const found = all.find((r) => r.id === named);
    if (found) return found;
    if (all.length === 1) {
      warn(`physics.backend${dimension} names "${named}", which isn't an enabled ${dimension.toUpperCase()} physics backend; using "${all[0].id}".`);
      return all[0];
    }
    warn(`physics.backend${dimension} names "${named}", which isn't an enabled ${dimension.toUpperCase()} physics backend.`);
    return null;
  }
  if (all.length > 1) warn(`Several ${dimension.toUpperCase()} physics backends are enabled (${all.map((r) => r.id).join(", ")}); using "${all[0].id}". Choose one with physics.backend${dimension}.`);
  return all[0] ?? null;
}
