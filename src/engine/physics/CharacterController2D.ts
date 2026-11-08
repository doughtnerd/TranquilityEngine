import { GameBehavior } from "../core/Component";
import { Vector2, type Vec2Like } from "../core/math";
import { component, field } from "../core/registry";
import type { GameObject } from "../scene/GameObject";
import type { CollisionFlags } from "./CharacterController";
import { Collider2D } from "./Collider2D";
import type { RigidBody2D } from "./RigidBody2D";

/** Passed to `onControllerColliderHit` for each collider a CharacterController2D's `move` ran into. */
export interface ControllerColliderHit2D {
  readonly controller: CharacterController2D;
  readonly collider: Collider2D;
  readonly gameObject: GameObject;
  readonly rigidbody: RigidBody2D | null;
  readonly point: Vector2;
  readonly normal: Vector2;
  readonly moveDirection: Vector2;
  readonly moveLength: number;
}

const NO_FLAGS: CollisionFlags = { below: false, sides: false, above: false };

/**
 * The 2D CharacterController (ADR 0091): an upright capsule (`radius`, `height` with the caps
 * included) that moves by `move(motion)`, sliding along what it hits, climbing slopes up to
 * `slopeLimit` and steps up to `stepOffset`, sticking to the ground over small drops
 * (`snapToGround`) and, with `pushBodies`, pushing dynamic bodies. "Up" is +y. Gravity is yours to
 * apply, or use `simpleMove`.
 */
@component("engine.CharacterController2D")
export class CharacterController2D extends Collider2D {
  @field(Number) radius = 0.5;
  @field(Number) height = 2;
  /** The steepest slope it walks up, in degrees. */
  @field(Number) slopeLimit = 45;
  /** The highest step it climbs, in units (0: none). */
  @field(Number) stepOffset = 0.3;
  /** Gap kept between the capsule and what it touches, in units. */
  @field(Number) skinWidth = 0.02;
  /** How far down it sticks to the ground, in units (0: never). */
  @field(Number) snapToGround = 0.2;
  @field(Boolean) pushBodies = true;
  /** How heavy it is when pushing bodies. */
  @field(Number) mass = 1;
  /** Ride kinematic and dynamic bodies it stands on (moving platforms), moving with them each fixed step. */
  @field(Boolean) moveWithPlatforms = true;

  /** @internal */ _flags: CollisionFlags = NO_FLAGS;
  /** @internal */ _velocity = new Vector2();
  /** @internal */ _fallSpeed = 0;

  /** True if the last `move` ended on the ground. */
  get isGrounded(): boolean {
    return this._flags.below;
  }

  /** Which sides touched something during the last `move`. */
  get collisionFlags(): CollisionFlags {
    return this._flags;
  }

  /** The velocity of the last `move` (distance moved over the frame's `deltaTime`). Returns a copy. */
  get velocity(): Vector2 {
    return this._velocity.clone();
  }

  override get attachedRigidbody(): RigidBody2D | null {
    return null;
  }

  /** Move by `motion`, sliding along what it hits. The node moves at once. See CharacterController.move. */
  move(motion: Vec2Like): CollisionFlags {
    const result = this._world.physics2D?.moveCharacter(this, motion);
    const t = this.node.transform;
    if (!result) {
      if (t) {
        const p = t.worldPosition;
        t.worldPosition = [p.x + motion.x, p.y + motion.y, p.z];
      }
      this._flags = NO_FLAGS;
      this.setVelocity(motion.x, motion.y);
      return this._flags;
    }
    this._flags = result.flags;
    this.setVelocity(result.movement.x, result.movement.y);
    const nodes = new Set([this.node, this.owner]);
    for (const hit of result.hits) {
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
    return this._flags;
  }

  /** Walk at `speed.x` units per second for this frame, falling with gravity when not grounded. Returns `isGrounded`. */
  simpleMove(speed: Vec2Like): boolean {
    const dt = this._world.time.deltaTime;
    const g = this._world.physics2D?.gravity.y ?? -9.81;
    this._fallSpeed = this.isGrounded ? Math.min(0, g * dt) : this._fallSpeed + g * dt;
    this.move({ x: speed.x * dt, y: this._fallSpeed * dt });
    if (this.isGrounded) this._fallSpeed = 0;
    return this.isGrounded;
  }

  private setVelocity(x: number, y: number): void {
    const dt = this._world.time.deltaTime;
    if (dt > 0) this._velocity.set(x / dt, y / dt);
  }

  override _shapeSignature(): string {
    return `character:${this.radius},${this.height}`;
  }

  /** @internal */
  _settingsSignature(): string {
    return [this.slopeLimit, this.stepOffset, this.skinWidth, this.snapToGround, this.pushBodies, this.mass].join("|");
  }
}
