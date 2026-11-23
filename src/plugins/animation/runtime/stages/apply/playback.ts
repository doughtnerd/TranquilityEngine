// `animation.Apply` sub-step: playback (T17). Ended plays resolve their promises (`finished`, `interrupted`, `stopped`) (ADR 0372).
// Called in its fixed place by `../apply.ts`; a no-op until T17.
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyPlayback(_frame: AnimationFrame): void {}
