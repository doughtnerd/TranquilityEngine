import { physics3DOf } from "./systems3d";
import { Component } from "../../../engine/core/Component";
import { Vector3, type Vec3Like } from "../../../engine/core/math";
import { PlainObject, component, field } from "../../../engine/core/registry";
import type { Dim3 } from "./backend";
import { BodyCommands, type BodyAxes } from "./bodyCommands";
import type { BodyState } from "./core/state";
import type { BodyType, ForceMode } from "../../../engine/physics/types";

const AXES_3D: BodyAxes<Dim3> = { linear: 3, angular: 3, vec: (a) => ({ x: a[0], y: a[1], z: a[2] }), ang: (a) => ({ x: a[0], y: a[1], z: a[2] }), fromVec: (v) => [v.x, v.y, v.z], fromAng: (w) => [w.x, w.y, w.z] };

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
  @field(String, { choices: ["dynamic", "kinematic", "static"], animatable: false }) bodyType: BodyType = "dynamic";
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

  /** @internal */ _state: BodyState<Dim3> | null = null;
  /** @internal What scripts asked of the body, applied at once or waiting for it (ADR 0283). */
  readonly _commands = new BodyCommands<Dim3>(AXES_3D);
  private readonly velocityStorage = [0, 0, 0];
  private readonly velocityView = Vector3.view(this.velocityStorage, 0, () => this._commands.setVelocity(this._state?.body, this.velocityStorage));

  /** Linear velocity in units/second (live view: assigning components changes the body). */
  get velocity(): Vector3 {
    const v = this._commands.velocity(this._state?.body);
    if (v) [this.velocityStorage[0], this.velocityStorage[1], this.velocityStorage[2]] = v;
    return this.velocityView;
  }
  set velocity(v: Vec3Like) {
    this._commands.setVelocity(this._state?.body, [v.x, v.y, v.z]);
  }

  /** Angular velocity in degrees/second around each world axis. Returns a copy. */
  get angularVelocity(): Vector3 {
    const [x, y, z] = this._commands.angularVelocity(this._state?.body);
    return new Vector3(x, y, z);
  }
  set angularVelocity(degPerSec: Vec3Like) {
    this._commands.setAngularVelocity(this._state?.body, [degPerSec.x, degPerSec.y, degPerSec.z]);
  }

  /** Apply a force for the next fixed step (`"force"`) or an instant change in momentum (`"impulse"`). */
  addForce(force: Vec3Like, mode: ForceMode = "force"): void {
    this._commands.addForce(this._state?.body, [force.x, force.y, force.z], mode, this.mass);
  }

  /** Apply a torque (around world axes) for the next fixed step, or an angular impulse. */
  addTorque(torque: Vec3Like, mode: ForceMode = "force"): void {
    const fr = this.constraints?.freezeRotation;
    this._commands.addTorque(this._state?.body, [torque.x, torque.y, torque.z], mode, this.mass, [!!fr?.x, !!fr?.y, !!fr?.z]);
  }

  override _onDetach(): void {
    physics3DOf(this._world)?.releaseBody(this);
  }
}
