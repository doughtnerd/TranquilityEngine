// `animation.Apply` (ADR 0370 frame order, step 5; 0372): the core's outputs back into the ECS, in one pass per feature.
// The order is fixed here, once; each feature fills only its own sub-step file (`apply/<feature>.ts`). Notifies go
// last, so the behaviours they call see this frame's fields, root motion, states and resolved plays. The same pass runs
// for fixed-mode Animators inside `animation.FixedEvaluate` (`frame.fixed`).
import type { World } from "../../../../engine/core/World";
import { applyEvents } from "./apply/events";
import { applyGraph } from "./apply/graph";
import { applyIK } from "./apply/ik";
import { applyNetwork } from "./apply/network";
import { applyNodes } from "./apply/nodes";
import { applyPhysical } from "./apply/physical";
import { applyPlayback } from "./apply/playback";
import { applyPose } from "./apply/pose";
import { applyProperties } from "./apply/properties";
import { applyRootMotion } from "./apply/rootMotion";
import { applyTweens } from "./apply/tweens";
import { frameFor, type AnimationFrame, type StageStep } from "./frame";

/** The apply sub-steps, in order. */
const APPLY: readonly StageStep[] = [
  applyNodes, // T45t: third-party node faults, one warning per node instance
  applyPose, // T17: bone matrices for skinning and attachments, LOD interpolation
  applyProperties, // T20t: property columns into ECS fields
  applyRootMotion, // T17: the RootMotion buffer, then the Transform, CharacterController or RigidBody
  applyGraph, // T32: AnimatorStateChanges and the reported states
  applyPlayback, // T17: ended plays resolve their promises
  applyTweens, // T22t: tween promises; entities without tweens lose animation.Tweens
  applyIK, // T40t: grounder ray requests for the next frame
  applyPhysical, // T44: fixed steps with a ragdoll connected: drive targets for this step
  applyNetwork, // T33: servers encode the replicated Animator fields
  applyEvents, // T20t: notifies to behaviours and AnimationEvents, last
];

/** @internal Run the apply sub-steps for `frame`. */
export function runApply(frame: AnimationFrame): void {
  const meter = frame.core.meter;
  const t = meter.start();
  try {
    for (let i = 0; i < APPLY.length; i++) APPLY[i]!(frame);
  } finally {
    meter.stop("apply", t);
  }
}

/** @internal The `animation.Apply` system. */
export function apply(world: World, dt: number): void {
  const frame = frameFor(world, dt, false);
  if (frame) runApply(frame);
}
