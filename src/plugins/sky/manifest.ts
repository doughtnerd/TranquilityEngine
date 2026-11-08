// The Sky plugin's manifest (ADR 0133, 0134), shared by its runtime and editor halves.
import type { PluginManifest } from "../manifest";

export const skyManifest: PluginManifest = {
  name: "myco.sky",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
  // Drawing only: the dedicated server skips it.
  server: false,
};
