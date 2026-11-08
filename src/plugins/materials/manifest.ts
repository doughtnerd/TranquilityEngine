// The Materials plugin's manifest (ADR 0133, 0134): materials, shader graphs and sub-graphs, shared
// by its runtime and editor halves.
import type { PluginManifest } from "../manifest";

export const materialsManifest: PluginManifest = {
  name: "myco.materials",
  title: "Materials",
  description: "Materials, shader graphs and sub-graphs, and their editors.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
  // Drawing only: the dedicated server skips it.
  server: false,
};
