// `animation.Apply` sub-step: tweens and timelines (T22t). The core's tween rows and sequence blocks are written into their
// fields; tween state changes resolve tween promises, and an entity whose last tween ended loses `animation.Tweens`
// (`features/tweens.ts`). TimelineDirectors' values, keyed records (audio and control keys) and play promises follow
// (`features/timeline.ts`): `../apply.ts` has no timeline step of its own, and timelines share the timeline table's
// outputs with groups. Called in its fixed place by `../apply.ts`.
import { applyTimelines } from "../../features/timeline";
import { applyTweens as apply } from "../../features/tweens";
import type { AnimationFrame } from "../frame";

/** @internal */
export function applyTweens(frame: AnimationFrame): void {
  apply(frame);
  applyTimelines(frame);
}
