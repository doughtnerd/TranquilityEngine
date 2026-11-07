// Particle effect assets in the editor (ADR 0057, 0060): creating `*.particles.json` graphs, reading
// and writing them, which one the Particle Graph panel has open, and each effect's undo history for
// the session. Files in the old `myco.particles@1` format read as migrated graphs and are written
// back as graphs on the first edit.
import { signal } from "@preact/signals";
import type { ParticleGraph, GraphProblem } from "../engine/scene/particleGraph";
import { defaultParticleGraph, formatParticleGraph, parseParticleGraph } from "../engine/scene/particleGraphFormat";
import { fileName } from "./assetBrowser";
import { freePath } from "./assetOps";
import { assetDocKind, assetToDoc, blockTemplate, docToAsset, formatAsset, subgraphTemplate } from "./particleGraph/assetDocs";
import { createGraphHistory, type GraphHistory } from "./graph/history";
import { showPanel } from "./layout/store";
import { errorStatus } from "./messages";
import type { EditorProject } from "./projects";
import { currentProject, docVersion, status } from "./state";

/** The effect open in the Particle Graph panel, or null. */
export const openParticleGraph = signal<string | null>(null);

/** Open an effect in the Particle Graph panel and bring the panel forward. */
export function openParticleGraphAsset(path: string): void {
  openParticleGraph.value = path;
  showPanel("particlegraph");
}

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
  try {
    if (kind) return { ...assetToDoc(project.assets.get(path), kind), migrated: false };
    return parseParticleGraph(project.assets.get(path), path);
  } catch (err) {
    return { graph: defaultParticleGraph(), problems: [{ severity: "error", message: (err as Error).message }], migrated: false };
  }
}

/** The file text for an open document: the graph, or the asset the document stands for. */
export const formatEffect = (graph: ParticleGraph, path: string): string => (assetDocKind(path) ? formatAsset(docToAsset(graph)) : formatParticleGraph(graph));

/** Each effect's writes in progress, so quick edits apply one after another. */
const writing = new Map<string, Promise<unknown>>();

/** Write a particle effect asset after the writes before it. Throws for a read-only project. */
export function writeEffect(project: EditorProject, path: string, graph: ParticleGraph): Promise<void> {
  const text = formatEffect(graph, path);
  const run = () => project.writeText(path, text);
  const result = (writing.get(path) ?? Promise.resolve()).then(run, run);
  const settled = result.catch(() => undefined);
  writing.set(path, settled);
  void settled.then(() => writing.get(path) === settled && writing.delete(path));
  return result;
}

const histories = createGraphHistory<ParticleGraph>();

/** An effect's undo history this session (kept while the panel shows another effect). */
export const effectHistory = (path: string): GraphHistory<ParticleGraph> => histories.get(path);
/** Remember `before` as the state to undo to, after an edit to the effect at `path`. */
export const recordEffectEdit = (path: string, before: ParticleGraph): void => histories.record(path, before);
export const undoEffectEdit = (path: string, current: ParticleGraph): ParticleGraph | undefined => histories.undo(path, current);
export const redoEffectEdit = (path: string, current: ParticleGraph): ParticleGraph | undefined => histories.redo(path, current);

/** Where New Particle Effect goes by default: `effects/` if the project has it, else the folder given. */
export function effectFolder(folder: string): string {
  return folder === "" && currentProject.value?.folders.includes("effects") ? "effects" : folder;
}

/**
 * Create `New Particle Effect.particles.json` (or `… 2`) in `folder`, holding `graph` (the Simple
 * Loop template when omitted). Returns its path, or null if the project is read-only or writing failed.
 */
export async function createParticleEffect(folder: string, graph: ParticleGraph = defaultParticleGraph(), name = "New Particle Effect"): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add particle effects.` };
    return null;
  }
  const path = freePath(project, effectFolder(folder), `${name}.particles.json`);
  try {
    await writeEffect(project, path, graph);
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${fileName(path)}.` };
  return path;
}

/** Create a file of `name` in `folder` holding `text`, with the same read-only and error handling as New Particle Effect. */
async function createAssetFile(folder: string, name: string, text: string, what: string): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add ${what}.` };
    return null;
  }
  const path = freePath(project, effectFolder(folder), name);
  try {
    await project.writeText(path, text);
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${fileName(path)}.` };
  return path;
}

/** Create `New Particle Sub-graph.particlesubgraph.json` (one number input wired to one number output), or one holding `asset`. Returns its path, or null. */
export const createParticleSubgraph = (folder: string, asset: Record<string, unknown> = subgraphTemplate(), name = "New Particle Sub-graph") =>
  createAssetFile(folder, `${name}.particlesubgraph.json`, formatAsset(asset), "particle sub-graphs");

/** Create `New Particle Block.particleblock.json` (one input driving a Set Size block). Returns its path, or null. */
export const createParticleBlock = (folder: string) => createAssetFile(folder, "New Particle Block.particleblock.json", formatAsset(blockTemplate()), "particle blocks");
