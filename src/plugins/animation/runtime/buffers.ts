/**
 * The animation buffers (ADR 0017, 0372): per-frame queues systems read. Notifies also call methods on the Animator's
 * behaviours (ADR 0372: no event bus), state changes and root motion are data only. `animation.Apply` (and
 * `animation.FixedEvaluate` for fixed-mode Animators) push them; they clear at the end of the frame.
 */
import { defineBuffer } from "../../../engine/core/data";
import type { Quaternion, Vector3 } from "../../../engine/core/math";
import type { GameObject } from "../../../engine/scene/GameObject";
import type { Animator } from "./components/Animator";

/** Which call of a notify a record is (ADR 0372): a one-off notify, or a notify state's begin, each frame inside it, and end. */
export type AnimationEventPhase = "instant" | "begin" | "tick" | "end";

/**
 * One notify (an `event` track key or notify state, ADR 0371, 0372). The behaviours of the Animator's node that define
 * `method` get `method(e)`; systems read the same records from `AnimationEvents`.
 */
export interface AnimationEvent {
  /** The Animator's node (whose behaviours got the call). */
  readonly node: GameObject;
  readonly animator: Animator;
  /** The method the track names. */
  readonly method: string;
  readonly phase: AnimationEventPhase;
  /** The key's arguments, as written in the clip. */
  readonly args: readonly (string | number | boolean | null)[];
  /** The clip the key belongs to (its asset reference). */
  readonly clip: string;
  /** The key's time in the clip, in seconds. */
  readonly time: number;
}

/** One state change of an Animator's state machine (ADR 0372). */
export interface AnimatorStateChange {
  readonly animator: Animator;
  /** The layer's name. */
  readonly layer: string;
  /** The state left, or null on the layer's first entry. */
  readonly from: string | null;
  /** The state entered. */
  readonly to: string;
}

/**
 * One frame's (or fixed step's) root motion of an Animator's node (ADR 0372), in the character's frame at the step's
 * start. Pushed in every `rootMotion` mode, `"none"` included, so systems can apply it themselves.
 */
export interface RootMotionRecord {
  readonly node: GameObject;
  readonly delta: { readonly position: Vector3; readonly rotation: Quaternion };
}

/** Notifies fired this frame (ADR 0372). */
export const AnimationEvents = defineBuffer<AnimationEvent>("animation.AnimationEvents");

/** State-machine state changes this frame (ADR 0372). */
export const AnimatorStateChanges = defineBuffer<AnimatorStateChange>("animation.AnimatorStateChanges");

/** Root motion this frame (ADR 0372). */
export const RootMotion = defineBuffer<RootMotionRecord>("animation.RootMotion");
