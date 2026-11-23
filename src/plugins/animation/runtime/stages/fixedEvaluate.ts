// `animation.FixedEvaluate` (ADR 0370 frame order, step 4): Animators with `updateMode: "fixed"` (physics-driven and
// predicted characters) run the same gather, evaluate and apply passes in the fixed step, before the physics push, so
// their root motion reaches CharacterControllers and kinematic RigidBodies and a connected ragdoll plugin reads this
// step's drive targets (`apply/physical.ts`).
import type { World } from "../../../../engine/core/World";
import { runApply } from "./apply";
import { runEvaluate } from "./evaluate";
import { frameFor } from "./frame";
import { runGather } from "./gather";

/** @internal The `animation.FixedEvaluate` system. */
export function fixedEvaluate(world: World, dt: number): void {
  const frame = frameFor(world, dt, true);
  if (!frame) return;
  runGather(frame);
  runEvaluate(frame);
  runApply(frame);
}
