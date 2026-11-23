/**
 * The animation plugin's built-in systems (ADR 0370 frame order, 0372), registered with `registerEngineSystems` so the
 * System catalogue and the Worlds panel list them. Each delegates to its stage (`stages/<stage>.ts`); a World with
 * nothing to animate costs one call per system per frame.
 *
 * - fixedUpdate (ADR 0011 step 4): `animation.PredictedRootMotion` (predicted, physics on) then `animation.FixedEvaluate`,
 *   after fixed-step scripts and navigation, before both physics pushes. A ragdoll plugin's systems go between
 *   `animation.FixedEvaluate` and the pushes.
 * - lateUpdate, before `lateUpdate()` scripts (ADR 0011 steps 5–6): `animation.Timeline`, `animation.Gather`,
 *   `animation.Evaluate`, `animation.Apply`. So they run after every update-phase script and system, and `lateUpdate()`
 *   sees this frame's pose and may override bones, as Unity's LateUpdate does.
 *
 * Every World runs them (no `worlds` filter): servers for root motion, sockets and notifies, clients and the editor's
 * preview World for poses.
 */
import type { BuiltinSystem } from "../../../engine/core/systems";
import { apply } from "./stages/apply";
import { evaluate } from "./stages/evaluate";
import { fixedEvaluate } from "./stages/fixedEvaluate";
import { gather } from "./stages/gather";
import { predictedRootMotion } from "./stages/predictedRootMotion";
import { timeline } from "./stages/timeline";

/** Systems the fixed animation step runs after: fixed-step scripts, then navigation's write-back (agents have moved). */
const FIXED_AFTER = ["engine.FixedUpdateScripts", "engine.NavWriteBack"];
/** The physics pushes (2D, then 3D) the fixed animation step runs before, so root motion and drive targets are in this step. */
const PHYSICS_PUSHES = ["engine.PhysicsPush", "engine.Physics3DPush"];
/** Frame animation runs before `lateUpdate()` scripts. */
const LATE_SCRIPTS = "engine.LateUpdateScripts";

/** @internal The systems every activation registers, in frame order. */
export const ANIMATION_SYSTEMS: readonly BuiltinSystem[] = [
  { name: "animation.FixedEvaluate", phase: "fixedUpdate", after: FIXED_AFTER, before: PHYSICS_PUSHES, run: fixedEvaluate },
  { name: "animation.Timeline", phase: "lateUpdate", before: ["animation.Gather", LATE_SCRIPTS], run: timeline },
  { name: "animation.Gather", phase: "lateUpdate", after: ["animation.Timeline"], before: [LATE_SCRIPTS], run: gather },
  { name: "animation.Evaluate", phase: "lateUpdate", after: ["animation.Gather"], before: [LATE_SCRIPTS], run: evaluate },
  { name: "animation.Apply", phase: "lateUpdate", after: ["animation.Evaluate"], before: [LATE_SCRIPTS], run: apply },
];

/**
 * @internal Registered only while the physics plugin is on (ADR 0374): predicted root-motion one-shots move
 * CharacterControllers with its queries (ADR 0370). It runs on the prediction timeline, after `engine.PredictionTick`
 * and fixed-step scripts (gameplay locomotion), and again for each re-simulated tick.
 */
export const PREDICTED_ROOT_MOTION_SYSTEM: BuiltinSystem = {
  name: "animation.PredictedRootMotion",
  phase: "fixedUpdate",
  predicted: true,
  after: ["engine.PredictionTick", ...FIXED_AFTER],
  before: ["animation.FixedEvaluate", ...PHYSICS_PUSHES],
  run: predictedRootMotion,
};
