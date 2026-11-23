// `animation.Timeline` (ADR 0372; T22t): before `animation.Gather`, TimelineDirectors seek (when a script wrote `playhead`)
// and advance their playheads as the core will this frame; their tracks then evaluate with everything else in
// `animation.Evaluate`, and the apply stage writes their values and resolves their play promises
// (`features/timeline.ts`). Instances are made when a director activates (its timeline loads asynchronously).
import type { World } from "../../../../engine/core/World";
import { runTimeline as advance } from "../features/timeline";
import { frameFor, type AnimationFrame } from "./frame";

/** @internal Advance `frame`'s TimelineDirectors. */
export function runTimeline(frame: AnimationFrame): void {
  advance(frame);
}

/** @internal The `animation.Timeline` system. */
export function timeline(world: World, dt: number): void {
  const frame = frameFor(world, dt, false);
  if (frame) runTimeline(frame);
}
