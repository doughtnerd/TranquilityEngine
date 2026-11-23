// `animation.Apply` sub-step: graph (T32). State-machine changes into `AnimatorStateChanges` and the state
// `Animator.state` reports, slot-play and travel promises, the core's refusals of graph commands (ADR 0372;
// `features/graph/runtime.ts`); then this frame's bone overrides are dropped (`features/bones.ts`: an override lasts
// one frame).
import { clearBoneOverrides } from "../../features/bones";
import { applyGraphs } from "../../features/graph/runtime";
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyGraph(frame: AnimationFrame): void {
  applyGraphs(frame);
  clearBoneOverrides(frame);
}
