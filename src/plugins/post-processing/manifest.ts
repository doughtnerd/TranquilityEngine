// The Post-processing plugin's manifest (ADR 0133, 0140), shared by its runtime and editor halves.
import type { PluginManifest } from "../manifest";

export const postProcessingManifest: PluginManifest = {
  name: "myco.post-processing",
  title: "Post-processing",
  description: "The PostProcessing component and colour LUTs.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
  // Where the Add Component menu lists its Components.
  componentCategories: {
    Rendering: ["engine.PostProcessing"],
  },
  // Drawing only: the dedicated server skips it.
  server: false,
};
