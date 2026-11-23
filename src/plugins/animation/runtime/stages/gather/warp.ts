// `animation.Gather` sub-step: warp (T40t). Motion-warp targets set with `Animator.warp` into the core as `WARP_TARGET`
// commands (ADR 0372; `features/warp/gather.ts`). Called in its fixed place by `../gather.ts`.
import { gatherWarps } from "../../features/warp/gather";
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherWarp(frame: AnimationFrame): void {
  gatherWarps(frame);
}
