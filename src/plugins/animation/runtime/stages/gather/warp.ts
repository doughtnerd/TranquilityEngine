// `animation.Gather` sub-step: warp (T40t). Motion-warp targets set with `Animator.warp` into the core (ADR 0372).
// Called in its fixed place by `../gather.ts`; a no-op until T40t.
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherWarp(_frame: AnimationFrame): void {}
