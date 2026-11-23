// `animation.Gather` sub-step: graph (T32). Computed parameters (`Animator.compute`) run once per Animator, then parameter
// rows, requests and travel, jump, slot, link and layer-weight commands go to the core, in call order (ADR 0372;
// `features/graph/runtime.ts`).
import { gatherGraphs } from "../../features/graph/runtime";
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherGraph(frame: AnimationFrame): void {
  gatherGraphs(frame);
}
