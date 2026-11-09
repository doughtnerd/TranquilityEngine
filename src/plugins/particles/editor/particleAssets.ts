// Particle effect assets in the editor (ADR 0057, 0060; the Particles plugin since 0134): which file
// the Particle Graph panel has open, reading effects, sub-graphs and custom blocks, and creating the
// last two. Editing (the write queue, undo and redo, outside changes, renames) goes through each
// file's asset document, `particleDocument(project, path)`, over the formats the plugin registers.
// Creating effects is here too (ADR 0146): the plugin's Hierarchy Create entry and its embedded-effect
// migration make them.
import { signal } from "@preact/signals";
import type { GraphProblem, ParticleGraph } from "../../../engine/scene/particleGraph";
import { defaultParticleGraph, formatParticleGraph } from "../../../engine/scene/particleGraphFormat";
import { assetDocKind, blockTemplate, formatAsset, subgraphTemplate } from "./particleGraph/assetDocs";
import { parseAssetDoc, parseEffect } from "./particleFormat";
import { editor, openAssetDocument, type AssetDocument, type EditorProject, type NodeEntry, type SceneDocument } from "../../../editor/sdk";


/** The effect open in the Particle Graph panel, or null. */
export const openParticleGraph = signal<string | null>(null);

/** Open an effect (or a sub-graph or block asset) in the Particle Graph panel and bring the panel forward. */
export function openParticleGraphAsset(path: string): void {
  openParticleGraph.value = path;
  editor.showPanel("particlegraph");
}

/** The format id of the file at `path`: an effect, a sub-graph or a custom block. */
export function particleFormatId(path: string): "particles" | "particlesubgraph" | "particleblock" {
  const kind = assetDocKind(path);
  return kind === "subgraph" ? "particlesubgraph" : kind === "block" ? "particleblock" : "particles";
}

/** The asset document editing the effect, sub-graph or block at `path`: its value, edits, undo and redo, saving. */
export const particleDocument = (project: EditorProject, path: string): AssetDocument<ParticleGraph> => openAssetDocument<ParticleGraph>(project, path, particleFormatId(path));

export interface ReadEffect {
  graph: ParticleGraph;
  /** What's wrong with the file (bad values read as the defaults). */
  problems: GraphProblem[];
  /** The file is in the old format (it's written as a graph on the next save). */
  migrated: boolean;
}

/**
 * A particle effect asset as the file holds it now. A sub-graph or custom block asset (`*.particlesubgraph.json`,
 * `*.particleblock.json`) reads as a document with Input, Output and block pseudo-nodes (see `particleGraph/assetDocs.ts`).
 */
export function readEffect(project: EditorProject, path: string): ReadEffect {
  const kind = assetDocKind(path);
  const raw = project.assets.get(path);
  return kind ? parseAssetDoc(raw, kind) : parseEffect(raw, path);
}

/** Replace a file's graph through its document (one undo step) and wait for the write. Throws for a read-only project. */
export function writeEffect(project: EditorProject, path: string, graph: ParticleGraph): Promise<void> {
  if (!project.canSave) return Promise.reject(new Error(`${project.name} is read-only.`));
  const doc = particleDocument(project, path);
  doc.edit(graph);
  return doc.flush();
}

/** Where New Particle Effect goes by default: `effects/` if the project has it, else the folder given. */
export function effectFolder(folder: string): string {
  return folder === "" && editor.project.current?.folders.includes("effects") ? "effects" : folder;
}

/**
 * Create `New Particle Effect.particles.json` (or `… 2`) in `folder`, holding `graph` (the Simple
 * Loop template when omitted). Returns its path, or null if the project is read-only or writing failed.
 */
export const createParticleEffect = (folder: string, graph: ParticleGraph = defaultParticleGraph(), name = "New Particle Effect"): Promise<string | null> =>
  createAssetFile(folder, `${name}.particles.json`, formatParticleGraph(graph), "particle effects");

/** Create a file of `name` in `folder` holding `text`, with the same read-only and error handling throughout. */
async function createAssetFile(folder: string, name: string, text: string, what: string): Promise<string | null> {
  return editor.project.createFile({ folder: effectFolder(folder), name, what, write: (project, path) => project.writeText(path, text) });
}

/** Create `New Particle Sub-graph.particlesubgraph.json` (one number input wired to one number output), or one holding `asset`. Returns its path, or null. */
export const createParticleSubgraph = (folder: string, asset: Record<string, unknown> = subgraphTemplate(), name = "New Particle Sub-graph") =>
  createAssetFile(folder, `${name}.particlesubgraph.json`, formatAsset(asset), "particle sub-graphs");

/** Create `New Particle Block.particleblock.json` (one input driving a Set Size block). Returns its path, or null. */
export const createParticleBlock = (folder: string) => createAssetFile(folder, "New Particle Block.particleblock.json", formatAsset(blockTemplate()), "particle blocks");

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
