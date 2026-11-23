// `animation.Gather` sub-step: music (T72). Plays, travels and requests waiting for a music boundary (`at`) are released
// when the heard clock reaches it, read through the audio plugin's public API (ADR 0372), and sent to the core in this
// frame (`features/music.ts`). Called in its fixed place by `../gather.ts`, after the graph and playback steps.
import { releaseMusic } from "../../features/music";
import type { AnimationFrame } from "../frame";

/** @internal */
export function gatherMusic(frame: AnimationFrame): void {
  releaseMusic(frame);
}
