// `animation.Apply` sub-step: events (T20t). Notifies, last: each Animator node's behaviours get `method(e)` through the World's behaviour messages, and the records go to `AnimationEvents` (ADR 0372).
// Called in its fixed place by `../apply.ts`; a no-op until T20t.
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyEvents(_frame: AnimationFrame): void {}
