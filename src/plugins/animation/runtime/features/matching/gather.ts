// Motion matching's trajectory input (ADR 0372; T42t, D60, D75): `animation.Gather` writes the character's own state into
// the graph parameters its pose-database nodes read (`inputs.ts`), straight into the instance's blackboard row (or as
// `SET_PARAM` past the row's 64 parameters), so this frame's evaluate sees them:
//
// - `position`: the Animator node's world position (vec2: x z; vec3: x y z);
// - `yaw`: its world yaw, radians about +Y, 0 facing +Z (D60);
// - `velocity`: the CharacterController's `velocity` on the Animator's node when physics is active and it has one
//   (`engine.CharacterController`, looked up by id: physics is optional), else the node's world motion over the
//   frame's dt (vec2: x z);
// - `lod`: `lodSearchMultiplier` to the power of the update-rate LOD level (1 at full rate, ×m at every 2nd frame,
//   ×m² at every 4th), so searches thin out with distance (ADR 0370).
//
// `desiredVelocity` and `desiredYaw` are gameplay's, set with `Animator.set`; the core's spring-damped prediction
// blends from the controller's velocity toward them.
import type { GraphParamType } from "../../../../../engine/animation/animGraph";
import { getComponentClass } from "../../../../../engine/core/registry";
import type { Component } from "../../../../../engine/core/Component";
import type { Vector3 } from "../../../../../engine/core/math";
import type { AnimationFrame } from "../../stages/frame";
import { HANDLE_INDEX_MASK } from "../../wasm/wire/core";
import { BLACKBOARD_DIRTY, BLACKBOARD_PARAMS, BLACKBOARD_STRIDE, BLACKBOARD_VALUES, SET_PARAM } from "../../wasm/wire/graph";
import { graphMeta } from "../graph/runtime";
import { encodeParameter, PARAM_TYPE_IDS } from "../graph/parameters";
import { animatorsOf, type AnimatorRuntime } from "../instances";
import { enabledCameras, lodStep } from "../playback/view";
import type { HostParameter } from "./inputs";

let physicsActive = false;

/** @internal Whether CharacterControllers give the velocity: set at each activation (`register.ts`). */
export function setMatchingPhysics(on: boolean): void {
  physicsActive = on;
}

interface ControllerLike extends Component {
  readonly velocity: Vector3;
}

/** Last frame's position per Animator, for the velocity of a character without a controller. */
const last = new WeakMap<AnimatorRuntime, { instance: number; x: number; y: number; z: number }>();
const words = new Uint32Array(4);

function controllerOf(rt: AnimatorRuntime): ControllerLike | null {
  if (!physicsActive) return null;
  const type = getComponentClass("engine.CharacterController");
  return type ? (rt.animator.node.getComponent(type as unknown as abstract new () => Component) as ControllerLike | null) : null;
}

function write(frame: AnimationFrame, instance: number, p: HostParameter, value: number | number[]): void {
  const v = typeof value === "number" ? (p.type === "int" ? Math.round(value) : value) : value;
  if (!encodeParameter(p.type as GraphParamType, v, words, 0)) return;
  if (p.index < BLACKBOARD_PARAMS) {
    const bb = frame.core.core.views().blackboard;
    const row = (instance & HANDLE_INDEX_MASK) * BLACKBOARD_STRIDE;
    const at = row + BLACKBOARD_VALUES + 16 * p.index;
    for (let k = 0; k < 4; k++) bb.setUint32(at + 4 * k, words[k]!, true);
    const dirty = row + BLACKBOARD_DIRTY + (p.index < 32 ? 0 : 4);
    bb.setUint32(dirty, (bb.getUint32(dirty, true) | (1 << (p.index & 31))) >>> 0, true);
  } else {
    frame.core.commands.put(SET_PARAM, { instance, param: p.index, paramType: PARAM_TYPE_IDS[p.type], w0: words[0]!, w1: words[1]!, w2: words[2]!, w3: words[3]! });
  }
}

const ground = (p: HostParameter, x: number, y: number, z: number): number[] => (p.type === "vec2" ? [x, z] : [x, y, z]);

/** @internal `animation.Gather`'s matching sub-step (see the file header). */
export function gatherMatchingInputs(frame: AnimationFrame): void {
  let cams: ReturnType<typeof enabledCameras> | null = null;
  for (const rt of animatorsOf(frame.world)) {
    if (rt.instance === 0 || rt.ns !== frame.core || (rt.animator.updateMode === "fixed") !== frame.fixed) continue;
    const inputs = graphMeta(rt.animator)?.matching;
    if (!inputs) continue;
    const t = rt.animator.node.transform;
    if (!t) continue;
    const pos = t.worldPosition;
    const prev = last.get(rt);
    const dt = rt.animator.updateMode === "unscaled" ? frame.unscaledDt : frame.dt;
    let vx = 0, vy = 0, vz = 0;
    const cc = controllerOf(rt);
    if (cc) ({ x: vx, y: vy, z: vz } = cc.velocity);
    else if (prev && prev.instance === rt.instance && dt > 0) {
      vx = (pos.x - prev.x) / dt;
      vy = (pos.y - prev.y) / dt;
      vz = (pos.z - prev.z) / dt;
    }
    last.set(rt, { instance: rt.instance, x: pos.x, y: pos.y, z: pos.z });
    const q = t.worldRotation;
    // The world forward (+Z rotated by q): yaw is its heading about +Y.
    const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const yaw = Math.atan2(fx, fz);
    for (const p of inputs.position) write(frame, rt.instance, p, ground(p, pos.x, pos.y, pos.z));
    for (const p of inputs.yaw) write(frame, rt.instance, p, yaw);
    for (const p of inputs.velocity) write(frame, rt.instance, p, ground(p, vx, vy, vz));
    if (inputs.lod.length) {
      cams ??= enabledCameras(frame.world);
      const m = Number.isFinite(rt.animator.lodSearchMultiplier) ? Math.max(1, rt.animator.lodSearchMultiplier) : 1;
      const level = Math.log2(lodStep(cams, rt));
      for (const p of inputs.lod) write(frame, rt.instance, p, m ** level);
    }
  }
}
