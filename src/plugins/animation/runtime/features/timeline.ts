// Timelines (ADR 0371, 0372; T22t): `TimelineDirector.play`, `pause` and `stop`. The director's `playhead` field is read and
// written by `animation.Timeline` (`stages/timeline.ts`), which runs before `animation.Gather`.
import type { TimelineDirector } from "../components/TimelineDirector";
import type { LifecycleHooks } from "../lifecycle";
import { notBuilt } from "../notBuilt";
import type { AnimationPlayResult } from "../types";

/** @internal `TimelineDirector.play`. */
export function playTimeline(_director: TimelineDirector): Promise<AnimationPlayResult> {
  return notBuilt("TimelineDirector.play", "T22t");
}

/** @internal `TimelineDirector.pause`. */
export function pauseTimeline(_director: TimelineDirector): void {
  notBuilt("TimelineDirector.pause", "T22t");
}

/** @internal `TimelineDirector.stop`. */
export function stopTimeline(_director: TimelineDirector): void {
  notBuilt("TimelineDirector.stop", "T22t");
}

/** @internal What a TimelineDirector's lifecycle does (T22t: deactivating or destroying it ends its play with `stopped`). */
export const timelineHooks: LifecycleHooks<TimelineDirector> = {};
