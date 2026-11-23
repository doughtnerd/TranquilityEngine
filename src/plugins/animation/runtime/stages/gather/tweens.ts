// `animation.Gather` sub-step: tweens (T22t). Tweens, sequences and parallel groups created since the last update start in the core's tween table; tweens of destroyed targets are killed (ADR 0371, 0372).
// Called in its fixed place by `../gather.ts`; a no-op until T22t.
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherTweens(_frame: AnimationFrame): void {}
