// The Camera Shake plugin's manifest (ADR 0436), shared by its runtime and editor halves.
import type { PluginManifest } from "../manifest";

export const cameraShakeManifest: PluginManifest = {
  name: "myco.camera-shake",
  title: "Camera Shake",
  description: "The CameraShake and ShakeImpulseSource components: impulses with presets and continuous noise that shake a camera's view.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
  // Where the Add Component menu lists its Components.
  componentCategories: {
    Rendering: ["engine.CameraShake", "engine.ShakeImpulseSource"],
  },
  // Collision and trigger impulses read the Physics plugin's contact buffers when it is on.
  optionalDependencies: {
    "myco.physics": "1.0.0",
  },
};
