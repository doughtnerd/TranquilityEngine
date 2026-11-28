// The Lines plugin's manifest (ADR 0396), shared by its runtime and editor halves.
import type { PluginManifest } from "../manifest";

export const linesManifest: PluginManifest = {
  name: "myco.lines",
  title: "Lines and Trails",
  description: "The LineRenderer and TrailRenderer components and their ribbon drawing, in 2D and 3D.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
  // Where the Add Component menu lists its Components.
  componentCategories: {
    Rendering: ["engine.LineRenderer", "engine.TrailRenderer"],
  },
};
