// The Environment plugin's manifest (ADR 0133, 0140), shared by its runtime and editor halves.
import type { PluginManifest } from "../manifest";

export const environmentManifest: PluginManifest = {
  name: "myco.environment",
  title: "Environment",
  description: "The Environment component and environment maps and cubemaps.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
  // Drawing only: the dedicated server skips it.
  server: false,
};
