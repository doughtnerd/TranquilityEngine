// `animation.PredictedRootMotion` (ADR 0370's hybrid prediction; T33): a predicted fixed-step system. For each predicted
// ghost playing a root-motion one-shot in a slot, it samples the clip's extracted root curve at the tick and moves the
// CharacterController with the physics plugin's queries against the current world: no physics stepping and no graph
// replay. It re-runs for each re-simulated tick after a correction. Registered only while the physics plugin is on.
// The work is in `features/network/predicted.ts`.
import type { World } from "../../../../engine/core/World";
import { runPredictedRootMotion } from "../features/network/predicted";
import { frameFor } from "./frame";

/** @internal The `animation.PredictedRootMotion` system. */
export function predictedRootMotion(world: World, dt: number): void {
  const frame = frameFor(world, dt, true);
  if (frame) runPredictedRootMotion(frame);
}
