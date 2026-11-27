import { physics2DOf } from "./systems2d";
import { Component } from "../../../engine/core/Component";
import { Vector2, type Vec2Like } from "../../../engine/core/math";
import { PlainObject, component, field } from "../../../engine/core/registry";
import type { Dim2 } from "./backend";
import { BodyCommands, type BodyAxes } from "./bodyCommands";
import type { BodyState } from "./core/state";

import type { BodyType, ForceMode } from "../../../engine/physics/types";
export type { BodyType, ForceMode };

const AXES_2D: BodyAxes<Dim2> = { linear: 2, angular: 1, vec: (a) => ({ x: a[0], y: a[1] }), ang: (a) => a[0], fromVec: (v) => [v.x, v.y], fromAng: (w) => [w] };

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
  @field(String, { choices: ["dynamic", "kinematic", "static"], animatable: false }) bodyType: BodyType = "dynamic";
  @field(Number) mass = 1;
  @field(Boolean) useGravity = true;
  @field(Number) gravityScale = 1;
  /** Linear damping. */
  @field(Number) drag = 0;
  /** Angular damping. */
  @field(Number) angularDrag = 0.05;
  @field(PlainObject) constraints: RigidBody2DConstraints = { freezePosition: { x: false, y: false }, freezeRotation: false };
  @field(String, { choices: ["discrete", "continuous"] }) collisionDetection: "discrete" | "continuous" = "discrete";
  /**
   * Show the body between its last two fixed steps when rendering, so it moves smoothly at any frame
   * rate (ADR 0093). It then trails the simulation by up to one step; headless Worlds never interpolate.
   */
  @field(Boolean) interpolate = true;

  /** @internal */ _state: BodyState<Dim2> | null = null;
  /** @internal What scripts asked of the body, applied at once or waiting for it (ADR 0283). */
  readonly _commands = new BodyCommands<Dim2>(AXES_2D);
  private readonly velocityStorage = [0, 0];
  private readonly velocityView = Vector2.view(this.velocityStorage, 0, () => this._commands.setVelocity(this._state?.body, this.velocityStorage));

  /** Linear velocity in units/second (live view: assigning components changes the body). */
  get velocity(): Vector2 {
    const v = this._commands.velocity(this._state?.body);
    if (v) [this.velocityStorage[0], this.velocityStorage[1]] = v;
    return this.velocityView;
  }
  set velocity(v: Vec2Like) {
    this._commands.setVelocity(this._state?.body, [v.x, v.y]);
  }

  /** Angular velocity in degrees/second. */
  get angularVelocity(): number {
    return this._commands.angularVelocity(this._state?.body)[0];
  }
  set angularVelocity(degPerSec: number) {
    this._commands.setAngularVelocity(this._state?.body, [degPerSec]);
  }

  /** Apply a force for the next fixed step (`"force"`) or an instant change in momentum (`"impulse"`). */
  addForce(force: Vec2Like, mode: ForceMode = "force"): void {
    this._commands.addForce(this._state?.body, [force.x, force.y], mode, this.mass);
  }

  /** Apply a torque for the next fixed step, or an angular impulse. */
  addTorque(torque: number, mode: ForceMode = "force"): void {
    this._commands.addTorque(this._state?.body, [torque], mode, this.mass, [!!this.constraints?.freezeRotation]);
  }

  /**
   * Pass down through every one-way collider (ADR 0437) the body stands on or overlaps now. One-way colliders reached
   * later still hold it, so the next platform below catches it; solid colliders always do. Does nothing on a backend
   * without one-way platforms.
   */
  dropThrough(): void {
    physics2DOf(this._world)?.dropThrough(this);
  }

  override _onDetach(): void {
    physics2DOf(this._world)?.releaseBody(this);
  }
}
