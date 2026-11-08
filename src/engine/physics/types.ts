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

/** Which sides of a CharacterController touched something during its last `move` (ADR 0091). */
export interface CollisionFlags {
  /** Touched ground it can stand on (or is snapped to it). */
  readonly below: boolean;
  /** Touched a wall or a slope too steep to climb. */
  readonly sides: boolean;
  /** Touched a ceiling. */
  readonly above: boolean;
}
