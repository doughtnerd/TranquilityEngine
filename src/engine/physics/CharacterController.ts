import { GameBehavior } from "../core/Component";
import { Vector3, type Vec3Like } from "../core/math";
import { component, field } from "../core/registry";
import type { GameObject } from "../scene/GameObject";
import { Collider } from "./Collider";
import type { RigidBody } from "./RigidBody";

/** Which sides of a CharacterController touched something during its last `move` (ADR 0091). */
export interface CollisionFlags {
  /** Touched ground it can stand on (or is snapped to it). */
  readonly below: boolean;
  /** Touched a wall or a slope too steep to climb. */
  readonly sides: boolean;
  /** Touched a ceiling. */
  readonly above: boolean;
}

/** Passed to `onControllerColliderHit` for each collider a CharacterController's `move` ran into. */
export interface ControllerColliderHit {
  readonly controller: CharacterController;
  readonly collider: Collider;
  readonly gameObject: GameObject;
  readonly rigidbody: RigidBody | null;
  /** Contact point on the collider, world space. */
  readonly point: Vector3;
  /** Surface normal of the collider at the point, world space. */
  readonly normal: Vector3;
  /** The direction of the `move` that hit it (unit length). */
  readonly moveDirection: Vector3;
  /** How far the move went before the hit. */
  readonly moveLength: number;
}

const NO_FLAGS: CollisionFlags = { below: false, sides: false, above: false };

/**
 * A character that moves by `move(motion)` and slides along what it hits instead of being pushed
 * by forces (ADR 0005, 0091), on Rapier's kinematic character controller. Its shape is an upright
 * capsule (`radius`, `height` with the caps included, at `center`) that doesn't turn with the node.
 * It climbs slopes up to `slopeLimit` and steps up to `stepOffset` high, keeps to the ground over
 * small drops (`snapToGround`), and with `pushBodies` pushes dynamic bodies it walks into as if it
 * weighed `mass`. It never needs a RigidBody, and ignores one on its node or above it.
 *
 * Gravity is yours to apply: add it to the motion you pass to `move`, or use `simpleMove`.
 */
@component("engine.CharacterController")
export class CharacterController extends Collider {
  @field(Number) radius = 0.5;
  @field(Number) height = 2;
  /** The steepest slope it walks up, in degrees; steeper ones are walls. */
  @field(Number) slopeLimit = 45;
  /** The highest step it climbs without jumping, in units (0: none). */
  @field(Number) stepOffset = 0.3;
  /** Gap kept between the capsule and what it touches, in units. Small but not zero. */
  @field(Number) skinWidth = 0.02;
  /** How far down it sticks to the ground when walking off small drops or down slopes, in units (0: never). */
  @field(Number) snapToGround = 0.2;
  /** Push dynamic bodies it runs into. */
  @field(Boolean) pushBodies = true;
  /** How heavy it is when pushing bodies. */
  @field(Number) mass = 1;
  /** Ride kinematic and dynamic bodies it stands on (moving platforms), moving with them each fixed step. */
  @field(Boolean) moveWithPlatforms = true;

  /** @internal */ _flags: CollisionFlags = NO_FLAGS;
  /** @internal */ _velocity = new Vector3();
  /** @internal simpleMove's falling speed. */ _fallSpeed = 0;

  /** True if the last `move` ended on the ground (or snapped to it). */
  get isGrounded(): boolean {
    return this._flags.below;
  }

  /** Which sides touched something during the last `move`. */
  get collisionFlags(): CollisionFlags {
    return this._flags;
  }

  /** The velocity of the last `move`: how far it actually went, over the frame's `deltaTime`. Returns a copy. */
  get velocity(): Vector3 {
    return this._velocity.clone();
  }

  /** Never attached to a body: a character controller moves itself. */
  override get attachedRigidbody(): RigidBody | null {
    return null;
  }

  /**
   * Move by `motion` (world units), sliding along walls, climbing slopes and steps, and stopping at
   * obstacles. The node moves at once. Returns which sides it touched; `onControllerColliderHit`
   * runs on the node's behaviors for each collider it hit. Before 3D physics has created the
   * controller (its first fixed step), the node moves unobstructed.
   */
  move(motion: Vec3Like): CollisionFlags {
    const physics = this._world.physics3D;
    const result = physics?.moveCharacter(this, motion);
    const t = this.node.transform;
    if (!result) {
      if (t) t.worldPosition = t.worldPosition.add(new Vector3(motion.x, motion.y, motion.z));
      this._flags = NO_FLAGS;
      this.setVelocity(motion.x, motion.y, motion.z);
      return this._flags;
    }
    this._flags = result.flags;
    this.setVelocity(result.movement.x, result.movement.y, result.movement.z);
    for (const hit of result.hits) dispatchHit(this, hit);
    return this._flags;
  }

  /**
   * Walk at `speed` (units per second, its vertical part ignored) for this frame, falling with the
   * World's gravity when not grounded. Returns `isGrounded`.
   */
  simpleMove(speed: Vec3Like): boolean {
    const dt = this._world.time.deltaTime;
    const g = this._world.physics3D?.gravity.y ?? -9.81;
    this._fallSpeed = this.isGrounded ? Math.min(0, g * dt) : this._fallSpeed + g * dt;
    this.move({ x: speed.x * dt, y: this._fallSpeed * dt, z: speed.z * dt });
    if (this.isGrounded) this._fallSpeed = 0;
    return this.isGrounded;
  }

  private setVelocity(x: number, y: number, z: number): void {
    const dt = this._world.time.deltaTime;
    if (dt > 0) this._velocity.set(x / dt, y / dt, z / dt);
  }

  override _shapeSignature(): string {
    return `character:${this.radius},${this.height}`;
  }

  /** @internal The controller's tuning, as the backend reads it. */
  _settingsSignature(): string {
    return [this.slopeLimit, this.stepOffset, this.skinWidth, this.snapToGround, this.pushBodies, this.mass].join("|");
  }
}

/** Call `onControllerColliderHit` on the controller's node's (and owner's) active behaviors. */
function dispatchHit(cc: CharacterController, hit: ControllerColliderHit): void {
  const nodes = new Set([cc.node, cc.owner]);
  for (const node of nodes) {
    for (const comp of [...node.getBehaviors(GameBehavior)]) {
      if (!comp.isActiveAndEnabled || !comp.onControllerColliderHit) continue;
      try {
        comp.onControllerColliderHit(hit);
      } catch (err) {
        console.error(`[myco] ${comp.constructor.name}.onControllerColliderHit threw:`, err);
      }
    }
  }
}
