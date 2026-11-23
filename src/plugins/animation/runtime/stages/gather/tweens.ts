// `animation.Gather` sub-step: tweens (T22t). Tweens, sequences and parallel groups created since the last update start in
// the core's tween table (groups as sequence programs); tweens of destroyed targets end "destroyed" (ADR 0371, 0372;
// `features/tweens.ts`). Called in its fixed place by `../gather.ts`.
import { gatherTweens as gather } from "../../features/tweens";
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherTweens(frame: AnimationFrame): void {
  gather(frame);
}
