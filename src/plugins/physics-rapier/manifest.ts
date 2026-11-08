// The Rapier physics plugin's manifest (ADR 0137): Rapier 2D and 3D backends for the Physics plugin.
// Runtime only: it holds the Rapier calls and conversions; everything shared is in `myco.physics`.
import type { PluginManifest } from "../manifest";

export const physicsRapierManifest: PluginManifest = {
  name: "myco.physics-rapier",
  title: "Rapier physics",
  description: "The Rapier physics backend, for 2D and 3D (loaded when a scene first needs physics).",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
  dependencies: { "myco.physics": "1.0.0" },
};
