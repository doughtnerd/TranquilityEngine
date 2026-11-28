// The Animation plugin's manifest (ADR 0133, 0370–0373), shared by its runtime and editor halves: skeletons, skinned
// meshes, 2D bones, Animators with their graphs, bone attachments, timelines and tweens, evaluated on the engine's
// Rust/WebAssembly core (`runtime/wasm/`). Physics and audio are optional (ADR 0374): with physics on, root motion can
// drive CharacterControllers and RigidBodies, the grounder casts rays and predicted root motion runs; with audio on,
// plays can wait for a beat, a bar or an exit marker (ADR 0372).
import type { PluginManifest } from "../manifest";

export const animationManifest: PluginManifest = {
  name: "myco.animation",
  title: "Animation",
  description: "Skeletal, property and sprite animation: Animators and their graphs, IK, retargeting, timelines and tweens.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
  // Where the Add Component menu lists its Components.
  componentCategories: {
    Animation: ["engine.Animator", "engine.BoneAttachment", "engine.Skeleton", "engine.Skeleton2D", "engine.TimelineDirector"],
    Rendering: ["engine.SkinnedMeshRenderer"],
  },
  optionalDependencies: {
    "myco.physics": "1.0.0",
    "myco.audio": "1.0.0",
  },
};
