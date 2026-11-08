// The Water plugin's manifest (ADR 0133, 0140), shared by its runtime and editor halves.
import type { PluginManifest } from "../manifest";

export const waterManifest: PluginManifest = {
  name: "myco.water",
  title: "Water",
  description: "The WaterSurface component and its drawing.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
};
