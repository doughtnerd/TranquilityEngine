// The Particles plugin's editor half (ADR 0133: effects, sub-graphs and custom blocks together; ADR
// 0134): the `particles`, `particlesubgraph` and `particleblock` asset kinds (New… entries, Inspector
// views, opening in the Particle Graph, accepted by effect fields, thumbnails, adding an effect to a scene), their asset formats,
// the Particle Graph panel and the ParticleSystem's Inspector section. Creating effects stays in core
// (`src/editor/particleAssets.ts`), as do the scene view's particle preview and the embedded-effect
// migration, which core code drives.
import type { EditorPlugin } from "../../../editor/sdk";
import { particlesManifest } from "../manifest";
import { createParticleBlock, createParticleEffect, createParticleSubgraph, openParticleGraphAsset, particleNodeEntry } from "./particleAssets";
import { particleBlockFormat, particlesFormat, particleSubgraphFormat } from "./particleFormat";

/** A page with a folded corner: the file icon effects have always shown until their thumbnail renders. */
const EFFECT_ICON = "M7 3h7l5 5v13H7zM14 3v5h5";
/** Two boxes wired through a third: a group of nodes used as one. */
const SUBGRAPH_ICON = "M4 6h5v4H4zM15 14h5v4h-5zM9 8h3v8h3M4 14h5v4H4z";
/** A stack of blocks. */
const BLOCK_ICON = "M5 4h14v5H5zM5 11h14v4H5zM5 17h14v3H5zM8 6.5h.01";

const assetInspector = () => import("./ui/ParticleInspector").then((m) => m.ParticleAssetInspector);

export const particlesEditorPlugin: EditorPlugin = {
  manifest: particlesManifest,
  activate(context) {
    context.registerAssetKind({
      id: "particles",
      extensions: [".particles.json"],
      label: "Particle Effect",
      icon: EFFECT_ICON,
      open: (path) => openParticleGraphAsset(path),
      inspector: () => import("./ui/ParticleInspector").then((m) => m.ParticleEffectInspector),
      create: { label: "New Particle Effect", create: (folder) => createParticleEffect(folder) },
      referencedAs: ["particles"],
      preview: "particles",
      addToScene: { nodes: (doc, path, position) => [particleNodeEntry(doc, path, position)] },
    });
    context.registerAssetKind({
      id: "particlesubgraph",
      extensions: [".particlesubgraph.json"],
      label: "Particle Sub-graph",
      icon: SUBGRAPH_ICON,
      open: (path) => openParticleGraphAsset(path),
      inspector: assetInspector,
      create: { label: "New Particle Sub-graph", create: (folder) => createParticleSubgraph(folder) },
    });
    context.registerAssetKind({
      id: "particleblock",
      extensions: [".particleblock.json"],
      label: "Particle Block",
      icon: BLOCK_ICON,
      open: (path) => openParticleGraphAsset(path),
      inspector: assetInspector,
      create: { label: "New Particle Block", create: (folder) => createParticleBlock(folder) },
    });
    context.registerAssetFormat(particlesFormat);
    context.registerAssetFormat(particleSubgraphFormat);
    context.registerAssetFormat(particleBlockFormat);
    context.registerPanel({
      id: "particlegraph",
      title: "Particle Graph",
      view: () => import("./ui/ParticleGraphPanel").then((m) => m.ParticleGraphPanel),
      // In the default layout, a tab beside the Scene view.
      beside: "scene",
    });
    // A ParticleSystem's effect is edited below its fields, not as raw JSON (ADR 0057).
    context.registerInspectorSection("engine.ParticleSystem", () => import("./ui/ParticleInspector").then((m) => m.ParticleSystemSection), { single: true });
  },
};
