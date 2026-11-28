// The Decals plugin's manifest (ADR 0395), shared by its runtime and editor halves.
import type { PluginManifest } from "../manifest";

export const decalsManifest: PluginManifest = {
  name: "myco.decals",
  title: "Decals",
  description: "The DecalProjector and Decal2D components, the Decals pool for spawned decals, and their drawing.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
  // Where the Add Component menu lists its Components.
  componentCategories: {
    Rendering: ["engine.DecalProjector", "engine.Decal2D"],
  },
};
