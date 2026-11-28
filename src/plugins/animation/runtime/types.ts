/**
 * The animation plugin's public option, result and handle types (ADR 0370–0372). Engine types only: no wasm, Rust or
 * Babylon types (ADR 0010). `myco` (`src/myco.ts`) exports every name here.
 */
import type { Curve } from "../../../engine/core/curve";
import type { Color, Quaternion, Vector2, Vector3 } from "../../../engine/core/math";
import type { Component } from "../../../engine/core/Component";
import type { GameObject } from "../../../engine/scene/GameObject";
import type { Transform } from "../../../engine/scene/Transform";
import type { AudioPlaylistHandle } from "../../audio/runtime";

// ------------------------------------------------------------------------------------------------ field values

/** How an Animator's time advances (ADR 0370): with the World's scaled time, unscaled time, or in fixed steps before physics. */
export type AnimatorUpdateMode = "normal" | "unscaled" | "fixed";

/**
 * What an Animator does while it can't be seen (ADR 0370): keep animating, freeze its pose while playheads advance
 * (`whenVisible`), or keep only root motion.
 */
export type AnimatorCullingMode = "always" | "whenVisible" | "rootMotionOnly";

/**
 * Where root motion goes (ADR 0372): nowhere (it is still written to the `RootMotion` buffer), the node's Transform,
 * its `CharacterController` or its kinematic `RigidBody` (the last two need the physics plugin).
 */
export type AnimatorRootMotion = "none" | "transform" | "characterController" | "rigidBody";

/** What an Animator's update-rate LOD measures (ADR 0370): nothing (every frame), distance to the camera, or screen size. */
export type AnimatorLodMetric = "off" | "distance" | "screenSize" | "lodGroup";

/** What a `BoneAttachment` copies from its bone (ADR 0372). */
export type BoneAttachmentFollow = "position" | "rotation" | "both";

/** What a `TimelineDirector` does at the timeline's end (ADR 0372): stay on the last frame, loop, or stop and reset. */
export type TimelineWrapMode = "hold" | "loop" | "none";

/**
 * How a `SkinnedMeshRenderer`'s culling bounds are found (ADR 0370): from the animated bones each frame, or the fixed
 * box `boundsCenter` / `boundsSize` (cheaper; for meshes whose motion stays inside a known box).
 */
export type SkinnedBoundsMode = "bones" | "fixed";

// ------------------------------------------------------------------------------------------------ Animator

/** An Animator layer, by name or index (0 is the base layer). */
export type AnimatorLayer = string | number;

/**
 * A graph parameter's value (ADR 0372): `float`/`int` (number), `bool`, `vec2`, `vec3`, `quat` or `node` (a GameObject,
 * or null for none). `set` checks the value against the parameter's declared kind.
 */
export type AnimatorParameterValue = number | boolean | Vector2 | Vector3 | Quaternion | GameObject | null;

/** Why a play (or a timeline) ended (ADR 0372). */
export type AnimationPlayEndReason = "finished" | "interrupted" | "stopped";

/** What the promise of `Animator.play`, `Animator.crossfade` and `TimelineDirector.play` resolves with: it never rejects, and never hangs. */
export interface AnimationPlayResult {
  readonly reason: AnimationPlayEndReason;
}

/**
 * Musical timing for plays, crossfades, travels and requests (ADR 0372), when the audio plugin is enabled: wait for the
 * next beat, bar or exit marker of `music`, and land the start or the clip's `hit` marker on it. A play released a
 * little after its boundary (frames are coarser than beats) starts that far into its clip. Without the audio plugin,
 * without `music`, or when the music stops first, `at` is refused with one warning and the action happens at once.
 */
export interface AnimatorMusicTiming {
  /** The music boundary to wait for. */
  readonly at?: "beat" | "bar" | "exit";
  /** The music the boundary belongs to (required with `at`). */
  readonly music?: AudioPlaylistHandle;
  /** What lands on the boundary: the clip's start (default) or its `hit` marker, as audio stingers do. */
  readonly align?: "start" | "hit";
}

/** Options of `Animator.play` (ADR 0372). */
export interface AnimatorPlayOptions extends AnimatorMusicTiming {
  /**
   * A slot of the graph to play the clip in, as a one-shot over the graph (Unreal's slots and montages). Without it the
   * clip plays on `layer` of the implicit graph (an Animator without a graph asset), or is refused with a warning when
   * the Animator has a graph.
   */
  readonly slot?: string;
  /** The layer of the implicit graph (default 0). Ignored with `slot`. */
  readonly layer?: AnimatorLayer;
  /** Seconds to fade in over what is playing (default 0: a cut, inertialized). */
  readonly fade?: number;
  /**
   * With `slot`: the part of the clip to play. A name is a section of the clip (its `cue` marker of that name, up to the
   * next cue or the clip's end); `{ start, end }` are clip seconds (`end` left out: the clip's end).
   */
  readonly section?: string | { readonly start: number; readonly end?: number };
  /** Playback speed (default 1; negative plays backward). */
  readonly speed?: number;
  /** Loop the clip (default: the clip's own setting). A looping play's promise resolves only when stopped or interrupted. */
  readonly loop?: boolean;
  /** Where to start, in normalised time (0–1, default 0). */
  readonly normalizedTime?: number;
}

/** Options of `Animator.crossfade` (ADR 0372; musical timing as `play`'s, T72). */
export interface AnimatorCrossfadeOptions extends AnimatorMusicTiming {
  /** The layer of the implicit graph (default 0). */
  readonly layer?: AnimatorLayer;
  /** An avatar mask asset (`*.mask.json`) restricting the clip to some bones. */
  readonly mask?: string;
  /** Playback speed (default 1). */
  readonly speed?: number;
  /** Loop the clip (default: the clip's own setting). */
  readonly loop?: boolean;
}

/** Options of `Animator.stop`. With neither `layer` nor `slot`, every play and slot stops. */
export interface AnimatorStopOptions {
  /** Stop what plays on this layer of the implicit graph. */
  readonly layer?: AnimatorLayer;
  /** Stop the one-shot in this slot. */
  readonly slot?: string;
  /** Seconds to fade out (default 0). */
  readonly fade?: number;
}

/** Options of `Animator.request` (ADR 0372). */
export interface AnimatorRequestOptions extends AnimatorMusicTiming {
  /** Seconds the request stays open for a transition to consume it (default 0.25). Never stale: it expires. */
  readonly within?: number;
}

/** Options of `Animator.travel` (ADR 0372). */
export interface AnimatorTravelOptions extends AnimatorMusicTiming {
  /** The layer whose state machine travels (default 0). */
  readonly layer?: AnimatorLayer;
}

/** What the promise of `Animator.travel` resolves with: it never rejects, and never hangs. */
export interface AnimatorTravelResult {
  /**
   * `arrived`: the machine entered the state (at once when it was already there); `unreachable`: no path leads there
   * (or the graph has no such state or layer), with a warning; `interrupted`: another `travel` or `jump` on the machine,
   * or the Animator losing its instance, came first.
   */
  readonly reason: "arrived" | "unreachable" | "interrupted";
}

/** Options of `Animator.jump`. */
export interface AnimatorJumpOptions {
  /** The layer whose state machine jumps (default 0). */
  readonly layer?: AnimatorLayer;
  /**
   * Enter the state this far in: cycles of its clips (0.5 is halfway; a looping clip wraps past 1, a one-shot holds its
   * end), as Unity's `Play(state, layer, normalizedTime)`. Default 0, the state's start. Nothing fires for the skipped part.
   */
  readonly normalizedTime?: number;
}

/** What `Animator.state(layer)` reports (ADR 0372). */
export interface AnimatorStateInfo {
  /** The active state's name ("" when the layer has none). */
  readonly name: string;
  /** Seconds since the state was entered. */
  readonly time: number;
  /** The state's playhead in its main clip, 0–1 per cycle (it passes 1 for looping clips). */
  readonly normalizedTime: number;
  /** The state's weight in the layer's output (below 1 while a transition blends it out). */
  readonly weight: number;
  /** The state a transition is blending to, or null. */
  readonly transitioningTo: string | null;
}

/** Options of `AnimatorIKTarget.target` (ADR 0372). */
export interface AnimatorIKOptions {
  /** How much the solver pulls toward the target, 0–1 (default 1). */
  readonly weight?: number;
  /** A rotation for the end bone (world space); default: keep the animated rotation. */
  readonly rotation?: Quaternion;
  /** How much the end bone turns to `rotation`, 0–1 (default 1 when `rotation` is given). */
  readonly rotationWeight?: number;
  /** A pole (elbow or knee) hint: a node or a world position. */
  readonly hint?: GameObject | Vector3;
}

/** One IK goal of an Animator's rig stack, by its name in the graph (`anim.ik("LeftHand")`, ADR 0372). */
export interface AnimatorIKTarget {
  /** The goal's name in the graph. */
  readonly name: string;
  /**
   * Aim the goal at a node (followed every frame at its world transform) or a world position; null releases it back to
   * the graph's own target or binding. Returns this handle.
   */
  target(target: GameObject | Vector3 | null, options?: AnimatorIKOptions): this;
}

/** Where a motion-warp window should land (ADR 0372): a world position and yaw, or a node to read them from. */
export type AnimatorWarpTarget = { readonly position?: Vector3; readonly rotation?: Quaternion } | GameObject;

/**
 * A bone of the Animator's skeleton for reading and overriding (`anim.bone("Head")`, ADR 0372). Reads give this frame's
 * evaluated local pose; writes override it for this frame only, applied after `lateUpdate()` and before attachments
 * follow and bones upload (write again each frame to keep an override).
 */
export interface AnimatorBone {
  /** The bone's name in the skeleton. */
  readonly name: string;
  /** Position relative to the parent bone. */
  localPosition: Vector3;
  /** Rotation relative to the parent bone. */
  localRotation: Quaternion;
  /** Scale relative to the parent bone. */
  localScale: Vector3;
}

/**
 * A typed view of one Animator's parameter row (`animatorParams(node)`, ADR 0372), for systems writing many Animators
 * (crowds). Look a name up once with `indexOf`, then set by index in the loop.
 */
export interface AnimatorParams {
  /** The parameter's index in the row, or -1 when the graph has no such parameter. */
  indexOf(name: string): number;
  /** Write a parameter by name or index; checked against the parameter's declared kind. */
  set(parameter: string | number, value: AnimatorParameterValue): void;
}

// ------------------------------------------------------------------------------------------------ tweens

/** Penner's easings by name (ADR 0371), as DOTween and PrimeTween name them. */
export type TweenEase =
  | "linear"
  | `${"in" | "out" | "inOut"}${"Sine" | "Quad" | "Cubic" | "Quart" | "Quint" | "Expo" | "Circ" | "Back" | "Elastic" | "Bounce"}`;

/** Why a tween (or a sequence or parallel group) ended (ADR 0372): `destroyed` when its target node or component was destroyed. */
export type TweenEndReason = "finished" | "stopped" | "destroyed";

/** What a tween's promise resolves with: it never rejects, and never hangs. */
export interface TweenResult {
  readonly reason: TweenEndReason;
}

/** What `tween()` animates: a Transform or a component. */
export type TweenTarget = Transform | Component;

/** A field value a tween can drive: numbers, booleans and the engine's vector, quaternion and colour types (or their numbers). */
export type TweenValue = number | boolean | Vector2 | Vector3 | Quaternion | Color | readonly number[];

/**
 * The fields of `T` a tween can drive (animatable fields of a component; position, rotation and scale fields of a
 * Transform), or a dotted path: a sub-path of a plain-object field (`"drive.targetRotation"`) or a MeshRenderer's
 * material property (`"material.color"`, a per-renderer override).
 */
export type TweenField<T> = ({ [K in keyof T]: T[K] extends number | boolean | Vector2 | Vector3 | Quaternion | Color ? K : never }[keyof T] & string) | `${string}.${string}`;

/** Options of `tween()` (ADR 0371). */
export interface TweenOptions {
  /** Seconds per cycle. */
  readonly duration: number;
  /** The start value (default: the field's value when the tween starts). */
  readonly from?: TweenValue;
  /** `to` is a change added to the start value (DOTween's `By`), not an end value. Default false. */
  readonly relative?: boolean;
  /** An easing by name, or any engine curve over 0–1 (default `"outQuad"`). */
  readonly ease?: TweenEase | Curve;
  /** Seconds before the first cycle (default 0). */
  readonly delay?: number;
  /** Cycles to play (default 1); -1 loops until stopped. */
  readonly loops?: number;
  /** How a loop restarts: from the start (default) or back and forth. */
  readonly loopMode?: "restart" | "yoyo";
  /** The clock the tween follows (default `"scaled"`): the World's scaled time, unscaled time, or fixed steps. */
  readonly time?: "scaled" | "unscaled" | "fixed";
  /** Its own time scale (default 1). */
  readonly speed?: number;
}

/**
 * A running tween, sequence or parallel group (ADR 0371, 0372). Awaitable: it resolves with a reason when it ends. A
 * tween starts at the next animation update after `tween()` returns; until then, passing it to `sequence()` or
 * `parallel()` hands its timing to the group. A tween that has started can't join a group.
 */
export interface Tween extends PromiseLike<TweenResult> {
  /** True until it ends. */
  readonly isPlaying: boolean;
  /** Hold it where it is. */
  pause(): void;
  /** Continue after `pause()`. */
  resume(): void;
  /** End it now, leaving the field where it is; resolves with `stopped`. */
  stop(): void;
}
