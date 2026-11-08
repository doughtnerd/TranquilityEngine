/**
 * What the shared sync core (ADR 0137) keeps on each physics Component, for both dimensions. Types only:
 * the Components import them without loading the core, which arrives with the backend.
 */
import type { BackendBody, BackendCollider, BackendJoint, DimensionTypes, Pose } from "../backend";

/** @internal */
export interface BodyState<D extends DimensionTypes> {
  body: BackendBody<D>;
  signature: string;
  syncedVersion: number;
  active: boolean;
  /** Interpolation (ADR 0093): the body's pose before and after the last step. */
  prev: Pose<D> | null;
  curr: Pose<D> | null;
  /** True while the Transform shows an interpolated pose rather than `curr`. */
  interpolated: boolean;
  /** The force and torque scripts applied for the coming step, for estimating joint forces (ADR 0092). */
  lastForce: number[];
  lastTorque: number[];
}

/** @internal */
export interface ColliderState<D extends DimensionTypes, RB> {
  collider: BackendCollider<D>;
  body: RB | null;
  signature: string;
  syncedVersion: number;
  active: boolean;
  /** A collider on a body's descendant: its pose relative to the body, to follow the node when it moves (ADR 0093). */
  local: Pose<D> | null;
  /** A character controller's own kinematic body, which carries its collider (ADR 0091). */
  ownBody?: BackendBody<D>;
  /** What the shape was built from beyond the signature (a mesh collider's meshes). */
  source?: readonly unknown[] | null;
}

/** @internal */
export interface JointState<D extends DimensionTypes, RB> {
  joint: BackendJoint;
  signature: string;
  settings: string;
  body: RB;
  connected: RB | null;
  /** The fixed body standing in for the world, when the joint isn't connected to a body. */
  ground: BackendBody<D> | null;
  /** 2D hinges: the angle (radians) between the bodies when it was made; limits and targets count from there. */
  restAngle: number;
  /** The anchor in each body's frame: this joint's body, then the connected one (or the ground). */
  local1: D["vec"];
  local2: D["vec"];
  /** For breakable joints: the dynamic body measured across the coming step, and its velocities before it. */
  measure: { rb: RB; local: D["vec"]; v0: D["vec"]; w0: D["ang"] } | null;
}

/** @internal What the core keeps for a TilemapCollider2D. */
export interface TilemapColliderState<D extends DimensionTypes, RB> {
  colliders: BackendCollider<D>[];
  /** The shape source's signature and the settings the colliders were built from. */
  signature: string;
  syncedVersion: number;
  body: RB | null;
  active: boolean;
}
