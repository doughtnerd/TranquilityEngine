// `animation.Apply` sub-step: properties (T20t). Property-track outputs scattered into their ECS columns in bulk through the binding table (ADR 0371).
// Called in its fixed place by `../apply.ts`; a no-op until T20t.
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyProperties(_frame: AnimationFrame): void {}
