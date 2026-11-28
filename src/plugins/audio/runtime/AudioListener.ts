/**
 * The ears of a World (ADR 0074). The first enabled AudioListener in the World that has the view sets
 * the audio backend's listener position and orientation each frame from its node: forward is the node's +Z, up
 * is +Y. Without one, the main camera is the listener. ADR 0462: `listenerNode` / `listenerPoseIn` are that rule, in one place.
 */
import { Component } from "../../../engine/core/Component";
import { Quaternion, Vector3, type Vec3Like } from "../../../engine/core/math";
import { component } from "../../../engine/core/registry";
import type { World } from "../../../engine/core/World";
import type { GameObject } from "../../../engine/scene/GameObject";
import { Camera } from "../../../engine/render/components";

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

/** Where the listener is and which way it faces (forward is the node's +Z, up its +Y), in world space. */
export interface ListenerPose {
  readonly position: Vector3;
  readonly forward: Vector3;
  readonly up: Vector3;
}

/** A node's place and facing (forward +Z, up +Y); null for a node with no transform. @internal */
export function listenerPose(node: GameObject): ListenerPose | null {
  const t = node.transform;
  if (!t) return null;
  const q = t.worldRotation;
  return { position: t.worldPosition, forward: rotate(q, 0, 0, 1), up: rotate(q, 0, 1, 0) };
}

/**
 * ADR 0462: the AudioListener that hears for `world`: the first active, enabled one on a node with a transform (one on a
 * node without a transform has no place, so it is passed over), or null. @internal
 */
export function activeListener(world: World): AudioListener | null {
  for (const l of world._componentsOfType(AudioListener)) if (l.isActiveAndEnabled && l.node.transform) return l;
  return null;
}

/**
 * ADR 0462: the node the World hears from: the `activeListener`'s node, else the active, enabled Camera with the lowest
 * depth (the first such on a tie) that has a transform; null when there is neither. Always a node with a transform. @internal
 */
export function listenerNode(world: World): GameObject | null {
  const l = activeListener(world);
  if (l) return l.node;
  let best: Camera | null = null;
  for (const c of world._componentsOfType(Camera)) if (c.isActiveAndEnabled && c.node.transform && (!best || c.depth < best.depth)) best = c;
  return best?.node ?? null;
}

/** ADR 0462: the pose of `listenerNode(world)`, or null when the World has no listener. @internal */
export function listenerPoseIn(world: World): ListenerPose | null {
  const node = listenerNode(world);
  return node ? listenerPose(node) : null;
}
