/**
 * The Ragdoll (ADR 0375): physical animation for the skeleton an Animator on its node (or above it) animates. Each bone
 * listed in `bones` gets a rigid body with a collider, joined to its parent bone's body by a ball joint with swing and
 * twist limits; bones without a body follow their parent body. An empty `bones` list uses the skeleton's default
 * description (the animation core's builder, from the skeleton's joint ranges or its profile roles) with shapes sized
 * from the rest pose (`generate.ts`).
 *
 * - `mode: "off"`: no bodies; the Animator's pose is the animation.
 * - `mode: "ragdoll"`: limp bodies under gravity (joint drives off, nothing pinned).
 * - `mode: "powered"`: each joint's drive turns its body toward the animated pose (strengths scaled by `strength`),
 *   and root bodies are pinned to the animation by `pinStrength` (PuppetMaster's muscle and pin weights).
 *
 * The simulated pose returns to the Animator's graph as its physical-pose input; `blend` is written each step to the
 * graph parameter `blendParameter`, which the graph's `physicsBlend` node reads as its weight (0 in `off`). A graph
 * for ragdolls has a `physicsBlend` whose physical input is a `physicalPose` node, a `poseSnapshot` node and get-up
 * states (`getUpFromBack`, `getUpFromFront`) in its Base state machine.
 *
 * `getUp()` (or `mode` going from `"ragdoll"` to `"off"` with `autoGetUp`) freezes the simulated pose into the graph's
 * pose snapshot and travels to the get-up state the pelvis's facing picks (lying on the back or on the front).
 *
 * Runtime state and systems live in `bodies.ts` and `systems.ts`; this class holds the settings.
 */
import { Component } from "../../../engine/core/Component";
import { PlainObject, component, field } from "../../../engine/core/registry";
import type { GameObject } from "../../../engine/scene/GameObject";
import type { AnimatorTravelResult } from "../../animation/runtime";
import { bodyNode, requestGetUp, ragdollDetached } from "./bodies";

/** What a ragdoll does (see `Ragdoll`). */
export type RagdollMode = "off" | "ragdoll" | "powered";

/** A body's collider: a capsule along `axis`, a box, or a sphere. */
export type RagdollShape = "capsule" | "box" | "sphere";

/** One bone's body, joint and muscle (ADR 0375). Frames are the body's: the bone's frame turned by `frame`. */
export interface RagdollBone {
  /** The skeleton bone's name. */
  bone: string;
  shape: RagdollShape;
  /** Box: its full size. Capsule: `x` the radius, `y` the full height along `axis`. Sphere: `x` the radius. */
  size: { x: number; y: number; z: number };
  /** The collider's centre in the body's frame. */
  center: { x: number; y: number; z: number };
  /** A capsule's axis in the body's frame. */
  axis: "x" | "y" | "z";
  /** Kilograms. */
  mass: number;
  /** Swing half-angles (degrees) about the joint's y and z axes; the joint's x axis is the body's (twist). */
  swing: { y: number; z: number };
  /** Twist range (degrees) about the body's x axis. */
  twist: { min: number; max: number };
  /** The joint drive (powered mode): stiffness (N·m/rad), damping (N·m·s/rad) and the torque limit (N·m). */
  stiffness: number;
  damping: number;
  maxForce: number;
  /** This muscle's strength multiplier. */
  strength: number;
  /** How strongly this body is pinned to the animation in powered mode, 0–1 (root bodies default to 1). */
  pin: number;
  /** The body's frame relative to the bone's (a unit quaternion); identity by default. */
  frame?: { x: number; y: number; z: number; w: number };
}

@component("engine.Ragdoll")
export class Ragdoll extends Component {
  /** Off, limp, or muscles driving toward the animation. */
  @field(String, { choices: ["off", "ragdoll", "powered"], description: "Off, limp ragdoll, or powered (muscles toward the animation)." })
  mode: RagdollMode = "off";
  /** The simulated pose's weight over the animation, 0–1 (the graph's `physicsBlend` weight). */
  @field(Number, { description: "How much of the simulated pose shows over the animation (0–1)." })
  blend = 1;
  /** Global muscle strength in powered mode (scales every drive). */
  @field(Number, { description: "Global muscle strength in powered mode." })
  strength = 1;
  /** How strongly root bodies follow the animation in powered mode, 0–1. */
  @field(Number, { description: "How strongly pinned bodies follow the animation in powered mode (0–1)." })
  pinStrength = 1;
  /** Per-bone bodies; empty uses the skeleton's default ragdoll. */
  @field(PlainObject, { animatable: false, description: "The bones with bodies; empty: the skeleton's default ragdoll." })
  bones: RagdollBone[] = [];
  /** The bone whose facing picks the get-up state; empty: the first root body. */
  @field(String, { animatable: false, description: "The pelvis bone (get-up facing); empty: the first root body." })
  pelvis = "";
  /** The pelvis's local axis out of the belly. */
  @field(String, { choices: ["+x", "-x", "+y", "-y", "+z", "-z"], animatable: false, description: "The pelvis's local axis out of the belly." })
  front: "+x" | "-x" | "+y" | "-y" | "+z" | "-z" = "+z";
  /** The graph's Base-machine state to get up from lying on the back. */
  @field(String, { animatable: false, description: "The graph state to get up from lying on the back." })
  getUpFromBack = "GetUpFromBack";
  /** The graph's Base-machine state to get up from lying on the front. */
  @field(String, { animatable: false, description: "The graph state to get up from lying on the front." })
  getUpFromFront = "GetUpFromFront";
  /** The graph's `physicalPose` node (the get-up snapshot's source). */
  @field(String, { animatable: false, description: "The graph's physicalPose node." })
  physicalPoseNode = "physical";
  /** The graph's `poseSnapshot` node the get-up blends from. */
  @field(String, { animatable: false, description: "The graph's poseSnapshot node for get-up." })
  snapshotNode = "snapshot";
  /** The graph's float parameter that `physicsBlend` reads as its weight. */
  @field(String, { animatable: false, description: "The graph parameter the physicsBlend weight reads." })
  blendParameter = "ragdollBlend";
  /** Get up when `mode` goes from "ragdoll" to "off". */
  @field(Boolean, { animatable: false, description: "Get up when mode goes from ragdoll to off." })
  autoGetUp = true;
  /** A Skeleton node moving farther than this (m) in one fixed step is a teleport: the bodies reset to the animation. */
  @field(Number, { animatable: false, description: "A jump of the character (m) in one step that resets the bodies." })
  teleportDistance = 2;

  /**
   * Get up now: freeze the simulated pose into the graph's pose snapshot, travel to the get-up state the pelvis's
   * facing picks, and turn the ragdoll off. Resolves when the state is entered (`arrived`), or `unreachable` when the
   * ragdoll isn't simulating, its facing is unknown or the graph lacks the state.
   */
  getUp(): Promise<AnimatorTravelResult> {
    return requestGetUp(this);
  }

  /** The node holding bone `bone`'s body while the ragdoll simulates (for forces and hit reactions), or null. */
  body(bone: string): GameObject | null {
    return bodyNode(this, bone);
  }

  override _onDeactivate(): void {
    ragdollDetached(this, false);
  }

  override _onDetach(): void {
    ragdollDetached(this, true);
  }
}
