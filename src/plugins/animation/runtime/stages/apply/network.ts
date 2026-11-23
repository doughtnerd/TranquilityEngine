// `animation.Apply` sub-step: network (T33). On servers, the replicated Animator fields encoded from the core's state (ADR 0370).
// Called in its fixed place by `../apply.ts`; a no-op until T33.
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyNetwork(_frame: AnimationFrame): void {}
