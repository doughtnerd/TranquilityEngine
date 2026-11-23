// `animation.Gather` sub-step: matching (T42t). Motion matching's trajectory input: the character's position, yaw and
// CharacterController velocity, and the LOD search multiplier, into the parameters the pose-database nodes read (ADR
// 0372, D75; `features/matching/gather.ts`). The desired velocity is gameplay's parameter. Called in its fixed place by
// `../gather.ts`.
import { gatherMatchingInputs } from "../../features/matching/gather";
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherMatching(frame: AnimationFrame): void {
  gatherMatchingInputs(frame);
}
