// `animation.Evaluate` (ADR 0370 frame order, step 5): one call into the core, `evaluate(world, dt_scaled, dt_unscaled)`,
// which runs every due instance (graphs, rig stacks, tweens, timelines) and fills the output views. Never one call per
// character. T13t built the call over its World service (`core/AnimationWorldCore.ts`); T17 plays through it.
import type { World } from "../../../../engine/core/World";
import { frameFor, type AnimationFrame } from "./frame";

/** @internal Evaluate the instances of `frame`'s mode (normal and unscaled, or fixed): the World's queued commands, then one `evaluate`. */
export function runEvaluate(frame: AnimationFrame): void {
  frame.core.evaluate(frame.pass, frame.dt, frame.unscaledDt);
}

/** @internal The `animation.Evaluate` system. */
export function evaluate(world: World, dt: number): void {
  const frame = frameFor(world, dt, false);
  if (frame) runEvaluate(frame);
}
