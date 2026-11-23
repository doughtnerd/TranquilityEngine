/**
 * The Ragdoll plugin's built-in systems (ADR 0375; the per-fixed-step order of `anim-physics`): `animation.FixedEvaluate`
 * writes this step's drive targets (`physics_drive`), then
 *
 * - `ragdoll.Drive` (before both physics pushes): bodies made, teleported or taken away as the modes say, joint drives
 *   and pins written from the targets;
 * - the physics push, step and write-back;
 * - `ragdoll.ReadBack` (after the 3D write-back, before its events): the simulated bodies back into the graphs'
 *   physical-pose inputs (`physics_read`), which the next evaluation shows.
 *
 * Every World runs them; a World without Ragdolls costs one lookup per system per step.
 */
import type { BuiltinSystem } from "../../../engine/core/systems";
import { driveRagdolls, readBackRagdolls } from "./bodies";
import { Ragdoll } from "./Ragdoll";

/** @internal */
export const RAGDOLL_SYSTEMS: readonly BuiltinSystem[] = [
  {
    name: "ragdoll.Drive",
    phase: "fixedUpdate",
    after: ["animation.FixedEvaluate"],
    before: ["engine.PhysicsPush", "engine.Physics3DPush"],
    run: (world, dt) => {
      const ragdolls = world._componentsOfType(Ragdoll);
      if (ragdolls.length) driveRagdolls(world, ragdolls, dt);
    },
  },
  {
    name: "ragdoll.ReadBack",
    phase: "fixedUpdate",
    after: ["engine.Physics3DWriteBack"],
    before: ["engine.Physics3DEvents"],
    run: (world) => readBackRagdolls(world),
  },
];
