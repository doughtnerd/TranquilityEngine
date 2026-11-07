import { Component } from "../core/Component";
import { DEG2RAD, RAD2DEG, Vector3, type Vec3Like } from "../core/math";
import { PlainObject, component, field } from "../core/registry";
import type { BodyHandleState3D } from "./Physics3DWorld";
import type { BodyType, ForceMode } from "./RigidBody2D";

export interface RigidBodyConstraints {
  freezePosition: { x: boolean; y: boolean; z: boolean };
  freezeRotation: { x: boolean; y: boolean; z: boolean };
}

/**
 * A 3D rigid body (ADR 0005, 0045), the 3D counterpart of RigidBody2D: the same fields, with
 * vectors in three dimensions and angular velocity in degrees per second around each axis.
 * Colliders on its node and its descendants (without a body of their own) move with it.
 */
@component("engine.RigidBody")
export class RigidBody extends Component {
  @field(String, { choices: ["dynamic", "kinematic", "static"] }) bodyType: BodyType = "dynamic";
  @field(Number) mass = 1;
  @field(Boolean) useGravity = true;
  @field(Number) gravityScale = 1;
  /** Linear damping. */
  @field(Number) drag = 0;
  /** Angular damping. */
  @field(Number) angularDrag = 0.05;
  @field(PlainObject) constraints: RigidBodyConstraints = { freezePosition: { x: false, y: false, z: false }, freezeRotation: { x: false, y: false, z: false } };
  @field(String, { choices: ["discrete", "continuous"] }) collisionDetection: "discrete" | "continuous" = "discrete";
  /**
   * Show the body between its last two fixed steps when rendering, so it moves smoothly at any frame
   * rate (ADR 0093). It then trails the simulation by up to one step; headless Worlds never interpolate.
   */
  @field(Boolean) interpolate = true;

  /** @internal */ _state: BodyHandleState3D | null = null;
  /** @internal */ _pendingVelocity: [number, number, number] | null = null;
  /** @internal */ _pendingAngularVelocity: [number, number, number] | null = null;
  /** @internal */ _force: [number, number, number] = [0, 0, 0];
  /** @internal */ _torque: [number, number, number] = [0, 0, 0];
  private readonly velocityStorage = [0, 0, 0];
  private readonly velocityView = Vector3.view(this.velocityStorage, 0, () => this.setVelocity(this.velocityStorage[0], this.velocityStorage[1], this.velocityStorage[2]));

  /** Linear velocity in units/second (live view: assigning components changes the body). */
  get velocity(): Vector3 {
    const body = this._state?.body;
    if (body) {
      const v = body.linvel();
      this.velocityStorage[0] = v.x;
      this.velocityStorage[1] = v.y;
      this.velocityStorage[2] = v.z;
    } else if (this._pendingVelocity) {
      [this.velocityStorage[0], this.velocityStorage[1], this.velocityStorage[2]] = this._pendingVelocity;
    }
    return this.velocityView;
  }
  set velocity(v: Vec3Like) {
    this.setVelocity(v.x, v.y, v.z);
  }

  /** Angular velocity in degrees/second around each world axis. Returns a copy. */
  get angularVelocity(): Vector3 {
    const body = this._state?.body;
    if (body) {
      const w = body.angvel();
      return new Vector3(w.x * RAD2DEG, w.y * RAD2DEG, w.z * RAD2DEG);
    }
    const p = this._pendingAngularVelocity ?? [0, 0, 0];
    return new Vector3(p[0], p[1], p[2]);
  }
  set angularVelocity(degPerSec: Vec3Like) {
    const body = this._state?.body;
    if (body) body.setAngvel({ x: degPerSec.x * DEG2RAD, y: degPerSec.y * DEG2RAD, z: degPerSec.z * DEG2RAD }, true);
    else this._pendingAngularVelocity = [degPerSec.x, degPerSec.y, degPerSec.z];
  }

  /** Apply a force for the next fixed step (`"force"`) or an instant change in momentum (`"impulse"`). */
  addForce(force: Vec3Like, mode: ForceMode = "force"): void {
    const body = this._state?.body;
    if (mode === "impulse" && body) {
      body.applyImpulse({ x: force.x, y: force.y, z: force.z }, true);
    } else if (mode === "impulse") {
      const m = this.mass > 0 ? this.mass : 1;
      const [vx, vy, vz] = this._pendingVelocity ?? [0, 0, 0];
      this._pendingVelocity = [vx + force.x / m, vy + force.y / m, vz + force.z / m];
    } else {
      this._force[0] += force.x;
      this._force[1] += force.y;
      this._force[2] += force.z;
    }
  }

  /** Apply a torque (around world axes) for the next fixed step, or an angular impulse. */
  addTorque(torque: Vec3Like, mode: ForceMode = "force"): void {
    const body = this._state?.body;
    if (mode === "impulse" && body) {
      body.applyTorqueImpulse({ x: torque.x, y: torque.y, z: torque.z }, true);
    } else {
      this._torque[0] += torque.x;
      this._torque[1] += torque.y;
      this._torque[2] += torque.z;
    }
  }

  private setVelocity(x: number, y: number, z: number): void {
    const body = this._state?.body;
    if (body) body.setLinvel({ x, y, z }, true);
    else this._pendingVelocity = [x, y, z];
  }

  override _onDetach(): void {
    this.world.physics3D?.releaseBody(this);
  }
}
