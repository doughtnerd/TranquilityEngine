// Particle effect assets in the editor (ADR 0057, 0060; the Particles plugin since 0134): editing an effect,
// sub-graph or custom block goes through its asset document, `particleDocument(project, path)`, over the formats
// the plugin's kinds declare. Creating, reading and opening them is the asset kind host's (ADR 0233:
// `editor.assets.create`, `read`, `open`); what's left here is the plugin's own: whether a file is in the old
// format, and the node that plays an effect.
import type { ParticleGraph } from "../../../engine/scene/particleGraph";
import { parseParticleGraph } from "../../../engine/scene/particleGraphFormat";
import { editor, openAssetDocument, type AssetDocument, type EditorProject, type NodeEntry, type SceneDocument } from "../../../editor/sdk";

/** The Particle Graph panel's id: the panel the plugin's three kinds open in. */
export const PARTICLE_GRAPH_PANEL = "particlegraph";

/** The asset document editing the effect, sub-graph or block at `path`: its value, edits, undo and redo, saving. */
export const particleDocument = (project: EditorProject, path: string): AssetDocument<ParticleGraph> => openAssetDocument<ParticleGraph>(project, path);

/**
 * True if the effect file at `path` is in the old `myco.particles@1` format (ADR 0057), so it's written as a graph
 * on its first edit. About the file, not the edited value, so it reads the file.
 */
export function effectFileMigrated(project: EditorProject, path: string): boolean {
  try {
    return parseParticleGraph(project.assets.get(path), path).migrated;
  } catch {
    return false;
  }
}

/** A node playing a particle effect asset (ADR 0057), named after the file: what adding an effect to a scene makes (ADR 0143). */
export function particleNodeEntry(doc: SceneDocument, effectPath: string, position: readonly [number, number, number] = [0, 0, 0]): NodeEntry {
  const name = editor.assets.fileName(effectPath).replace(/\.particles\.json$/i, "");
  return {
    id: editor.scene.uniqueId(doc, editor.scene.idBase(effectPath)),
    name: name.charAt(0).toUpperCase() + name.slice(1),
    components: [
      { type: "engine.Transform", data: { position: [...position] } },
      { type: "engine.ParticleSystem", data: { effect: `asset:${effectPath}` } },
    ],
  };
}
