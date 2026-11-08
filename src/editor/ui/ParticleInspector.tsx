// Deprecated (ADR 0134): the Particles plugin (`src/plugins/particles/editor/`) registers the Inspector
// views of particle effects, sub-graphs and custom blocks, and the ParticleSystem section. A registered
// kind's view wins in `AssetInspector.tsx`, so its built-in particle branches never reach these; they go
// with this file when those branches are removed. Core never imports a plugin's editor half.

/** @deprecated The Particles plugin's `particles` kind inspector replaces it. */
export function ParticleEffectInspector(_props: { path: string }) {
  return null;
}

/** @deprecated The Particles plugin's `particlesubgraph` and `particleblock` kind inspectors replace it. */
export function ParticleAssetInspector(_props: { path: string }) {
  return null;
}
