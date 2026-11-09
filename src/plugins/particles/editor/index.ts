// The Particles plugin's editor half (ADR 0133: effects, sub-graphs and custom blocks together; ADR
// 0134): the `particles`, `particlesubgraph` and `particleblock` asset kinds (New… entries, Inspector
// views, opening in the Particle Graph, accepted by effect fields, thumbnails; an effect added to a scene is a node playing it), their asset formats,
// the Particle Graph panel and the ParticleSystem's Inspector section; and (ADR 0146) the Hierarchy's Create
// Particle System, the scene view's particle preview with its overlay, and moving embedded effects into
// assets when a scene opens.
import type { EditorPlugin } from "../../../editor/sdk";
import { particlesManifest } from "../manifest";
import { particlesThumbnail } from "./thumbnail";
import { createParticleBlock, createParticleEffect, createParticleSubgraph, openParticleGraphAsset, particleNodeEntry } from "./particleAssets";
import { migrateEmbeddedEffects } from "./particleMigration";
import { installParticlePreview } from "./particlePreview";
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
      preview: particlesThumbnail,
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
    // Effects are assets (ADR 0060): Create Particle System writes a new one first, then adds the node
    // playing it. After Reflection Probe, as it has always been.
    context.registerHierarchyCreateEntry({
      id: "particle-system",
      label: "Particle System",
      name: "Particle System",
      after: "reflection-probe",
      createAsset: () => createParticleEffect("", undefined, "Particle System"),
      components: (position, effect) => [
        { type: "engine.Transform", data: { position } },
        { type: "engine.ParticleSystem", data: effect ? { effect } : {} },
      ],
    });
    // The scene view's preview of the selected system (ADR 0057): kept in step on each scene view; its
    // controls float over the scene view.
    context.registerViewportTool({ id: "myco.particles.preview", install: (view) => installParticlePreview(view.engine) });
    context.registerPanelExtension({ id: "myco.particles.preview", panel: "scene", view: () => import("./ui/ParticlePreviewOverlay").then((m) => m.ParticlePreviewOverlay) });
    // Embedded effects (ADR 0057) move into assets when a scene opens in a project that can save (ADR 0060).
    context.registerSceneOpenMigration({ id: "myco.particles.embedded-effects", failure: "move the embedded particle effects out of", migrate: migrateEmbeddedEffects });
  },
};
