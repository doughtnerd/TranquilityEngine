/**
 * Node family `physics` (`anim-graph/src/physics.rs`): the ragdoll's simulated pose as a graph input, and its blend
 * with the animated pose (ADR 0375). Internal: not public API.
 */
import { I, kind, P, type NodeFamilyCatalogue } from "./schema";

export const PHYSICS_NODES: NodeFamilyCatalogue = {
  family: "physics",
  kinds: [
    kind("physics", "physicalPose", 0, "The ragdoll's simulated pose; bones without a body keep the fallback's.", I.range(0, 1, "fallback"), []),
    kind("physics", "physicsBlend", 1, "Blends the physical pose over the animated one per bone (PuppetMaster's pin weight).", I.fixed("animated", "physical"), [
      P.animated("weight", 1, "The physical pose's weight.", { unit: "ratio", min: 0, max: 1 }),
      P.asset("mask", "mask", "A bone mask scaling the weight per bone (none: every bone)."),
    ]),
  ],
};
