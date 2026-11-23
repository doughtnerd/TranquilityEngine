// `animation.Apply` sub-step: graph (T32). State-machine changes into `AnimatorStateChanges` and the state `Animator.state` reports (ADR 0372).
// Called in its fixed place by `../apply.ts`; a no-op until T32.
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyGraph(_frame: AnimationFrame): void {}
