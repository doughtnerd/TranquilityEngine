// `animation.Gather` sub-step: graph (T32). Computed parameters (`Animator.compute`) run once per Animator, then parameter rows, requests and travel, jump and link commands go to the core (ADR 0372).
// Called in its fixed place by `../gather.ts`; a no-op until T32.
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherGraph(_frame: AnimationFrame): void {}
