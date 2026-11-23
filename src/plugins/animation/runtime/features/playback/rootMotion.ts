// Root motion into the scene (ADR 0370, 0372; T17). The core reports each instance's root delta per step in the
// character's frame at the step's start (D35): a translation and a turn about +Y. Every mode pushes it to the
// `RootMotion` buffer; then, by `Animator.rootMotion`:
//
// - `none`: nothing more (the clip's root movement stays in the pose, as Unity's `applyRootMotion = false`);
// - `transform`: the Animator's node moves by the delta, turned into world space by its world rotation;
// - `characterController` (physics on): `CharacterController.move` with that world delta (it slides and stops at
//   obstacles), and the turn on the Transform;
// - `rigidBody` (physics on): a kinematic body's Transform moves (the physics push turns that into a velocity-aware
//   kinematic move before the step); a dynamic body gets the delta as its planar velocity (keeping its vertical speed,
//   so gravity still acts) and the turn as its angular velocity about +Y.
//
// Without the physics plugin, the last two warn once and do nothing beyond the buffer. They belong in fixed mode (the
// move lands before the physics push); in normal mode they still apply, a frame's motion at a time.
import { getComponentClass } from "../../../../../engine/core/registry";
import { Quaternion, Vector3 } from "../../../../../engine/core/math";
import type { Component } from "../../../../../engine/core/Component";
import type { GameObject } from "../../../../../engine/scene/GameObject";
import type { AnimatorRuntime } from "../instances";

let physicsActive = false;

/** @internal Set by the playback registration seam on each activation (ADR 0374: read at activation). */
export function setRootMotionPhysics(active: boolean): void {
  physicsActive = active;
}

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** The physics component `id` on `node`, when the physics plugin is on and registered it. */
function physicsComponent(node: GameObject, id: string): Component | null {
  if (!physicsActive) return null;
  const type = getComponentClass(id);
  return type ? node.getComponent(type as unknown as abstract new () => Component) : null;
}

interface CharacterControllerLike extends Component {
  move(motion: { x: number; y: number; z: number }): unknown;
}

interface RigidBodyLike extends Component {
  bodyType: string;
  velocity: Vector3;
  angularVelocity: Vector3;
}

/**
 * @internal Applies one step's root delta (`t` translation, `q` rotation, in the character's frame) to `rt`'s node by
 * its `rootMotion` mode. `dt` is the step's seconds (a dynamic body's velocity).
 */
export function applyRootDelta(rt: AnimatorRuntime, t: Vector3, q: Quaternion, dt: number): void {
  const mode = rt.animator.rootMotion;
  if (mode === "none") return;
  const node = rt.animator.node;
  const transform = node.transform;
  if (!transform) return;
  const heading = transform.worldRotation;
  const world = Quaternion.rotate(heading, t);
  if (mode === "transform") {
    transform.worldPosition = transform.worldPosition.add(world);
    transform.worldRotation = heading.multiply(q).normalize();
    return;
  }
  if (mode === "characterController") {
    const cc = physicsComponent(node, "engine.CharacterController") as CharacterControllerLike | null;
    if (!cc) {
      warnOnce(`cc:${node.name}`, `[myco] ${node.name}: Animator root motion "characterController" needs the physics plugin and a CharacterController on the node; only the RootMotion buffer gets it.`);
      return;
    }
    cc.move(world);
    transform.worldRotation = heading.multiply(q).normalize();
    return;
  }
  const rb = physicsComponent(node, "engine.RigidBody") as RigidBodyLike | null;
  if (!rb) {
    warnOnce(`rb:${node.name}`, `[myco] ${node.name}: Animator root motion "rigidBody" needs the physics plugin and a RigidBody on the node; only the RootMotion buffer gets it.`);
    return;
  }
  if (rb.bodyType === "kinematic") {
    transform.worldPosition = transform.worldPosition.add(world);
    transform.worldRotation = heading.multiply(q).normalize();
    return;
  }
  if (dt <= 0) return;
  const v = rb.velocity;
  rb.velocity = new Vector3(world.x / dt, v.y, world.z / dt);
  const yaw = 2 * Math.atan2(q.y, q.w);
  rb.angularVelocity = new Vector3(0, (yaw / dt) * (180 / Math.PI), 0);
}
