// Per-Animator rig state on the host (ADR 0370, 0372; T40t): IK goals set from code (`Animator.ik`), the character frame
// the last evaluate used, last frame's grounder rays in world space, and what teleport detection compares against.
import type { Quaternion } from "../../../../../engine/core/math";
import type { GameObject } from "../../../../../engine/scene/GameObject";
import type { Animator } from "../../components/Animator";
import { RIG_MAX_RAYS } from "../../wasm/wire/rig";
import { CharacterFrame } from "./frame";

/** @internal A point a goal aims at: a node (followed each frame) or a fixed world position. */
export type GoalTarget = GameObject | { readonly x: number; readonly y: number; readonly z: number };

/** @internal An IK goal set from code. */
export interface IKGoal {
  target: GoalTarget | null;
  weight: number;
  /** World rotation for the end bone, or null (a node target's own rotation when `rotationWeight` was given). */
  rotation: Quaternion | null;
  rotationWeight: number;
  hint: GoalTarget | null;
}

/** Floats per world ray: origin xyz, unit direction xyz, length. */
export const RAY_FLOATS = 7;

/** @internal An Animator's rig state. */
export interface RigState {
  readonly goals: Map<string, IKGoal>;
  /** The character frame written for the last gather, and the instance it was written for (0: none). */
  readonly frame: CharacterFrame;
  instance: number;
  /** Grounder rays requested by the last evaluate, in world space (`RAY_FLOATS` each), and which rows are valid. */
  readonly rays: Float64Array;
  readonly rayValid: Uint8Array;
  /** The instance the rays belong to (0: none). */
  rayInstance: number;
}

const states = new WeakMap<Animator, RigState>();

/** @internal An Animator's rig state (made on first use). */
export function rigState(animator: Animator): RigState {
  let s = states.get(animator);
  if (!s) {
    s = { goals: new Map(), frame: new CharacterFrame(), instance: 0, rays: new Float64Array(RIG_MAX_RAYS * RAY_FLOATS), rayValid: new Uint8Array(RIG_MAX_RAYS), rayInstance: 0 };
    states.set(animator, s);
  }
  return s;
}
