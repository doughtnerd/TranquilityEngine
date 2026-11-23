// `animation.Gather` sub-step: network (T33). On clients, the replicated Animator fields (`netStates`, `netSlots`, `netLinks`, `netParameters`) into the core: interpolated ghosts evaluate at the interpolated tick (ADR 0370).
// Called in its fixed place by `../gather.ts`; a no-op until T33.
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherNetwork(_frame: AnimationFrame): void {}
