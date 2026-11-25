// The Lights 2D plugin's manifest (ADR 0399), shared by its runtime and editor halves.
import type { PluginManifest } from "../manifest";

export const lights2dManifest: PluginManifest = {
  name: "myco.lights2d",
  title: "Lights 2D",
  description: "The Light2D and ShadowCaster2D components, their gizmos and shape tools, and the 2D Lighting settings.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
};
