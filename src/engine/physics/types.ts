/**
 * Types shared by the 2D and 3D physics plugins (ADR 0045, 0135). They stay in core so neither plugin
 * imports the other; `myco` exports them through the physics plugins' runtime halves.
 */

export type BodyType = "dynamic" | "kinematic" | "static";
export type ForceMode = "force" | "impulse";

/** A collider's surface, in 2D and 3D: how it slides and how it bounces. */
export interface PhysicsMaterial {
  friction: number;
  bounciness: number;
}
/** The 2D name `PhysicsMaterial` had first. */
export type PhysicsMaterial2D = PhysicsMaterial;

/** A joint's range of movement: degrees for hinges, units for sliders. */
export interface JointLimits {
  min: number;
  max: number;
}

/** Drives a hinge or slider at `targetVelocity` (degrees or units per second) with at most `force`. */
export interface JointMotor {
  targetVelocity: number;
  force: number;
}

/** Pulls a hinge or slider towards `targetPosition` (degrees or units) with stiffness `spring` and damping `damper`. */
export interface JointSpring {
  spring: number;
  damper: number;
  targetPosition: number;
}

/**
 * A ball joint's swing range (ADR 0375): how far, in degrees, the joint's body may turn around the joint frame's
 * y axis and around its z axis (the frame's x axis is the twist axis). The cone the twist axis sweeps is
 * elliptical when the two differ.
 */
export interface BallSwing {
  y: number;
  z: number;
}

/**
 * Drives a ball joint's body towards `targetRotation` (ADR 0375): the body's rotation relative to the connected
 * body, as a turn away from the pose the joint was made in, in the joint's frame (x is the twist axis), a plain
 * `{ x, y, z, w }` quaternion. `stiffness` (torque per radian) and `damping` (torque per radian per second) shape
 * the spring; `maxForce` is the most torque it may apply (0 turns the drive off in effect).
 */
export interface BallDrive {
  targetRotation: { x: number; y: number; z: number; w: number };
  stiffness: number;
  damping: number;
  maxForce: number;
}

/**
 * What a joint is (ADR 0305), 2D or 3D: welded (`fixed`), turning about an axis (`hinge`), sliding along one
 * (`slider`), turning freely about a point (`ball`, 3D only), at most a length apart (`rope`) or pulled towards
 * one (`spring`).
 */
export type JointKind = "fixed" | "hinge" | "slider" | "ball" | "rope" | "spring";

/** @internal A rope or spring: its length is between its anchors, and an auto-configured one measures from the connected body's origin. */
export const isDistanceJoint = (kind: JointKind): kind is "rope" | "spring" => kind === "rope" || kind === "spring";

/** Which sides of a CharacterController touched something during its last `move` (ADR 0091). */
export interface CollisionFlags {
  /** Touched ground it can stand on (or is snapped to it). */
  readonly below: boolean;
  /** Touched a wall or a slope too steep to climb. */
  readonly sides: boolean;
  /** Touched a ceiling. */
  readonly above: boolean;
}
