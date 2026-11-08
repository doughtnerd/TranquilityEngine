// The Meshes and models plugin's manifest (ADR 0133, 0140), shared by its runtime and editor halves.
import type { PluginManifest } from "../manifest";

export const meshesManifest: PluginManifest = {
  name: "myco.meshes",
  title: "Meshes and models",
  description: "The MeshRenderer component, model assets (OBJ, FBX, glTF) and their instanced drawing.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
};
