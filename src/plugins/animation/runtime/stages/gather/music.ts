// `animation.Gather` sub-step: music (T72). Plays, travels and requests waiting for a music boundary (`at`) are released when it arrives, read through the audio plugin's public API (ADR 0372).
// Called in its fixed place by `../gather.ts`; a no-op until T72.
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherMusic(_frame: AnimationFrame): void {}
