// `animation.Apply` sub-step: tweens (T22t). Tween state changes resolve tween promises; an entity whose last tween ended loses `animation.Tweens` (ADR 0372).
// Called in its fixed place by `../apply.ts`; a no-op until T22t.
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyTweens(_frame: AnimationFrame): void {}
