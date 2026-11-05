/**
 * The ears of a World (ADR 0074). The first enabled AudioListener in the World that has the view sets
 * Howler's listener position and orientation each frame from its node: forward is the node's -Z, up
 * is +Y. Without one, the main camera is the listener.
 */
import { Component } from "../core/Component";
import { Quaternion, Vector3 } from "../core/math";
import { component } from "../core/registry";
import type { GameObject } from "../scene/GameObject";

@component("engine.AudioListener")
export class AudioListener extends Component {}

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
