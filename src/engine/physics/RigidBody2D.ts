import { Component } from "../core/Component";
import { DEG2RAD, RAD2DEG, Vector2, type Vec2Like } from "../core/math";
import { PlainObject, component, field } from "../core/registry";
import type { BodyHandleState } from "./Physics2DWorld";

export type BodyType = "dynamic" | "kinematic" | "static";
export type ForceMode = "force" | "impulse";

export interface RigidBody2DConstraints {
  freezePosition: { x: boolean; y: boolean };
  freezeRotation: boolean;
}

/**
 * A 2D rigid body (ADR 0005). Field names follow the Unity-style API from the
 * CannonIntegration branch; `bodyType` replaces the old isKinematic/mass-0 overloading and
 * `useGravity` scales gravity instead of changing mass.
 */
@component("engine.RigidBody2D")
export class RigidBody2D extends Component {
  @field(String, { choices: ["dynamic", "kinematic", "static"] }) bodyType: BodyType = "dynamic";
  @field(Number) mass = 1;
  @field(Boolean) useGravity = true;
  @field(Number) gravityScale = 1;
  /** Linear damping. */
  @field(Number) drag = 0;
  /** Angular damping. */
  @field(Number) angularDrag = 0.05;
  @field(PlainObject) constraints: RigidBody2DConstraints = { freezePosition: { x: false, y: false }, freezeRotation: false };
  @field(String, { choices: ["discrete", "continuous"] }) collisionDetection: "discrete" | "continuous" = "discrete";
  /** Reserved: render interpolation between fixed steps is not implemented yet. */
  @field(Boolean) interpolate = false;

  /** @internal */ _state: BodyHandleState | null = null;
  /** @internal */ _pendingVelocity: [number, number] | null = null;
  /** @internal */ _pendingAngularVelocity: number | null = null;
  /** @internal */ _force: [number, number] = [0, 0];
  /** @internal */ _torque = 0;
  private readonly velocityStorage = [0, 0];
  private readonly velocityView = Vector2.view(this.velocityStorage, 0, () => this.setVelocity(this.velocityStorage[0], this.velocityStorage[1]));

  /** Linear velocity in units/second (live view: assigning components changes the body). */
  get velocity(): Vector2 {
    const body = this._state?.body;
    if (body) {
      const v = body.linvel();
      this.velocityStorage[0] = v.x;
      this.velocityStorage[1] = v.y;
    } else if (this._pendingVelocity) {
      [this.velocityStorage[0], this.velocityStorage[1]] = this._pendingVelocity;
    }
    return this.velocityView;
  }
  set velocity(v: Vec2Like) {
    this.setVelocity(v.x, v.y);
  }

  /** Angular velocity in degrees/second. */
  get angularVelocity(): number {
    const body = this._state?.body;
    return body ? body.angvel() * RAD2DEG : (this._pendingAngularVelocity ?? 0);
  }
  set angularVelocity(degPerSec: number) {
    const body = this._state?.body;
    if (body) body.setAngvel(degPerSec * DEG2RAD, true);
    else this._pendingAngularVelocity = degPerSec;
  }

  /** Apply a force for the next fixed step (`"force"`) or an instant change in momentum (`"impulse"`). */
  addForce(force: Vec2Like, mode: ForceMode = "force"): void {
    const body = this._state?.body;
    if (mode === "impulse" && body) {
      body.applyImpulse({ x: force.x, y: force.y }, true);
    } else if (mode === "impulse") {
      const m = this.mass > 0 ? this.mass : 1;
      const [vx, vy] = this._pendingVelocity ?? [0, 0];
      this._pendingVelocity = [vx + force.x / m, vy + force.y / m];
    } else {
      this._force[0] += force.x;
      this._force[1] += force.y;
    }
  }

  addTorque(torque: number, mode: ForceMode = "force"): void {
    const body = this._state?.body;
    if (mode === "impulse" && body) body.applyTorqueImpulse(torque, true);
    else this._torque += torque;
  }

  private setVelocity(x: number, y: number): void {
    const body = this._state?.body;
    if (body) body.setLinvel({ x, y }, true);
    else this._pendingVelocity = [x, y];
  }

  override _onDetach(): void {
    this.world.physics2D?.releaseBody(this);
  }
}
