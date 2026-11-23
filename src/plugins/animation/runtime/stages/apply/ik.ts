// `animation.Apply` sub-step: ik (T40t). The grounder's ray requests for the next frame (ADR 0370).
// Called in its fixed place by `../apply.ts`; a no-op until T40t.
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyIK(_frame: AnimationFrame): void {}
