// The Particles plugin's manifest (ADR 0133, 0134), shared by its runtime and editor halves.
import type { PluginManifest } from "../manifest";

export const particlesManifest: PluginManifest = {
  name: "myco.particles",
  title: "Particles",
  description: "Particle effects, their sub-graphs and custom blocks, the Particle Graph and the ParticleSystem component.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
  // Drawing only (particles are cosmetic and never replicated): the dedicated server skips it.
  server: false,
};
