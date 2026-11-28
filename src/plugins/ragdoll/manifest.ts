// The Ragdoll plugin's manifest (ADR 0133, 0375): ragdolls and powered (PuppetMaster-style) ragdolls on animated
// skeletons — the `Ragdoll` component, rigid bodies and ball joints built from the skeleton, joint drives toward the
// animated pose, the simulated pose blended back into the Animator's graph, and get-up. It needs the Physics plugin
// (bodies, ball-joint limits and drives) and the Animation plugin (skeletons, drive targets, the physical-pose input),
// so animation works without physics and physics without animation.
import type { PluginManifest } from "../manifest";

export const ragdollManifest: PluginManifest = {
  name: "myco.ragdoll",
  title: "Ragdoll",
  description: "Ragdolls and powered ragdolls on animated skeletons: bodies and joints from the skeleton, muscles toward the animation, get-up.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
  // Where the Add Component menu lists its Components.
  componentCategories: {
    Animation: ["engine.Ragdoll"],
  },
  dependencies: { "myco.physics": "1.0.0", "myco.animation": "1.0.0" },
};
