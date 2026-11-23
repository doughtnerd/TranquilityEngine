// `animation.Evaluate` (ADR 0370 frame order, step 5): one call into the core, `evaluate(world, dt_scaled, dt_unscaled)`,
// which runs every due instance (graphs, rig stacks, tweens, timelines) and fills the output views. Never one call per
// character. T13t builds the call over its World service; T17 plays through it.
import type { World } from "../../../../engine/core/World";
import { frameFor, type AnimationFrame } from "./frame";

/** @internal Evaluate the instances of `frame`'s mode (normal and unscaled, or fixed). No-op until T13t. */
export function runEvaluate(_frame: AnimationFrame): void {}

/** @internal The `animation.Evaluate` system. */
export function evaluate(world: World, dt: number): void {
  const frame = frameFor(world, dt, false);
  if (frame) runEvaluate(frame);
}
