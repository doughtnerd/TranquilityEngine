// The Ragdoll plugin's runtime half (ADR 0133, 0135, 0375): the `Ragdoll` component and its fixed-step systems. It
// reaches the animation plugin only through its ragdoll contribution point (`PHYSICAL_ANIMATION`: drive targets, the
// physical-pose input, the pose snapshot) and physics through its public Components (RigidBody, colliders, BallJoint).
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder.
import type { RuntimePlugin } from "../../runtimeContext";
import { PHYSICAL_ANIMATION, type PhysicalAnimationClient } from "../../animation/runtime";
import { ragdollManifest } from "../manifest";
import { connectSource, disconnectSource } from "./bodies";
import { Ragdoll } from "./Ragdoll";
import { RAGDOLL_SYSTEMS } from "./systems";

export * from "./public";
/** @internal For the editor's ragdoll builder (T55). */
export { generateRagdollBones, type RagdollRigData } from "./generate";

const client: PhysicalAnimationClient = {
  id: "myco.ragdoll",
  connect: connectSource,
  disconnect: disconnectSource,
};

export const ragdollRuntimePlugin: RuntimePlugin = {
  manifest: ragdollManifest,
  activate(context) {
    context.registerComponents([Ragdoll]);
    context.registerEngineSystems(RAGDOLL_SYSTEMS);
    context.contribute(PHYSICAL_ANIMATION, client);
  },
};
