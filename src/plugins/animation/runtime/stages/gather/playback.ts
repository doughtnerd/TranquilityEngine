// `animation.Gather` sub-step: playback (T17). Animator fields (update mode, culling and visibility, LOD rate, layer weights) and play, crossfade and stop commands into the core (ADR 0370, 0372).
// Called in its fixed place by `../gather.ts`; a no-op until T17.
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherPlayback(_frame: AnimationFrame): void {}
