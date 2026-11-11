/**
 * The ears of a World (ADR 0074). The first enabled AudioListener in the World that has the view sets
 * the audio backend's listener position and orientation each frame from its node: forward is the node's -Z, up
 * is +Y. Without one, the main camera is the listener.
 */
import { Component } from "../../../engine/core/Component";
import { Quaternion, Vector3, type Vec3Like } from "../../../engine/core/math";
import { component } from "../../../engine/core/registry";
import type { GameObject } from "../../../engine/scene/GameObject";

@component("engine.AudioListener")
export class AudioListener extends Component {
  private readonly estimated = new Vector3();
  private readonly overridden = new Vector3();
  /** @internal ADR 0162 §1.4: the velocity `setVelocity` gave, or null to estimate (the audio system passes it to the Doppler pass). */
  _velocityOverride: Vector3 | null = null;

  /**
   * ADR 0162 §1.4: the listener's velocity in world units per second, from the node's motion (or `setVelocity`'s value).
   * Doppler uses it. Read-only: change it with `setVelocity`.
   */
  get velocity(): Vector3 {
    return this._velocityOverride ? this.overridden : this.estimated;
  }

  /**
   * ADR 0162 §1.4: drive the listener's velocity from physics (world units per second), or set zero across a camera cut;
   * null goes back to estimating it from the node's motion.
   */
  setVelocity(v: Vec3Like | null): void {
    // The audio system hands the override to the listener frame; the Doppler pass writes it (or the estimate) to `frame.vel*`.
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) {
      this.overridden.set(v.x, v.y, v.z);
      this._velocityOverride = this.overridden;
    } else this._velocityOverride = null;
  }

  /** @internal The audio system, each frame: the listener velocity the Doppler pass wrote to the frame (the estimate, or the override). */
  _noteVelocity(x: number, y: number, z: number): void {
    if (this.estimated.x !== x || this.estimated.y !== y || this.estimated.z !== z) this.estimated.set(x, y, z);
  }
}

/** Rotate (x, y, z) by `q`. */
function rotate(q: Quaternion, x: number, y: number, z: number): Vector3 {
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  return new Vector3(x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx));
}

/** A node's place and facing for the audio listener. @internal */
export function listenerPose(node: GameObject): { position: Vector3; forward: Vector3; up: Vector3 } {
  const t = node.transform!;
  const q = t.worldRotation;
  return { position: t.worldPosition, forward: rotate(q, 0, 0, -1), up: rotate(q, 0, 1, 0) };
}
