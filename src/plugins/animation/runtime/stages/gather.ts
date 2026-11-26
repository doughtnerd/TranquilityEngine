// `animation.Gather` (ADR 0370 frame order, step 5; 0372): everything the core reads this frame goes into its input views,
// in one pass per feature. The order is fixed here, once; each feature fills only its own sub-step file
// (`gather/<feature>.ts`). The same pass runs for fixed-mode Animators inside `animation.FixedEvaluate`
// (`frame.fixed`); each sub-step takes only the Animators of its frame's mode.
import type { World } from "../../../../engine/core/World";
import { frameFor, type AnimationFrame, type StageStep } from "./frame";
import { gatherGraph } from "./gather/graph";
import { gatherIK } from "./gather/ik";
import { gatherMatching } from "./gather/matching";
import { gatherMusic } from "./gather/music";
import { gatherNetwork } from "./gather/network";
import { gatherPlayback } from "./gather/playback";
import { gatherTweens } from "./gather/tweens";
import { gatherWarp } from "./gather/warp";

/** The gather sub-steps, in order. */
const GATHER: readonly StageStep[] = [
  gatherNetwork, // T33: on clients, replicated Animator state lands first, so local commands apply on top
  gatherGraph, // T32: computed parameters, then parameter rows, requests and travel, jump and link commands
  gatherPlayback, // T17: Animator fields (mode, culling, visibility, LOD rate, layer weights), play and stop commands
  gatherMusic, // T72: plays, travels and requests whose music boundary arrives this frame
  gatherTweens, // T22t: tweens and groups created since the last update; destroyed targets
  gatherIK, // T40t: IK targets' transforms, last frame's grounder hits (rays through the physics plugin when it is on)
  gatherWarp, // T40t: motion-warp targets
  gatherMatching, // T42t: trajectory and desired velocity for motion matching
];

/** @internal Run the gather sub-steps for `frame`. */
export function runGather(frame: AnimationFrame): void {
  const meter = frame.core.meter;
  const t = meter.start();
  try {
    for (let i = 0; i < GATHER.length; i++) GATHER[i]!(frame);
  } finally {
    meter.stop("gather", t);
  }
}

/** @internal The `animation.Gather` system. */
export function gather(world: World, dt: number): void {
  const frame = frameFor(world, dt, false);
  if (frame) runGather(frame);
}
