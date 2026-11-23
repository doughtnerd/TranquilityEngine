// `animation.Gather` sub-step: ik (T40t). IK targets (code targets and `ikTargets` bindings) at their world transforms, the
// character frame, rig LOD, teleport resets, and last frame's grounder hits, cast through the physics plugin's ray API
// when it is on (ADR 0370, 0372; `features/ik/gather.ts`). Called in its fixed place by `../gather.ts`.
import { gatherRig } from "../../features/ik/gather";
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherIK(frame: AnimationFrame): void {
  gatherRig(frame);
}
