// `animation.Timeline` (ADR 0372; T22t): before `animation.Gather`, TimelineDirectors advance (or seek, when a script wrote
// `playhead`), start on `playOnStart`, wrap, and resolve their play promises; their tracks then evaluate with everything
// else in `animation.Evaluate`.
import type { World } from "../../../../engine/core/World";
import { frameFor, type AnimationFrame } from "./frame";

/** @internal Advance `frame`'s TimelineDirectors. No-op until T22t. */
export function runTimeline(_frame: AnimationFrame): void {}

/** @internal The `animation.Timeline` system. */
export function timeline(world: World, dt: number): void {
  const frame = frameFor(world, dt, false);
  if (frame) runTimeline(frame);
}
