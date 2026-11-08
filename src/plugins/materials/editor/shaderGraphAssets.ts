// Shader graph assets in the editor (ADR 0046, 0047; the Materials plugin since 0134): creating
// `*.shadergraph.json` files, reading them, and which one the Shader Graph panel has open. Editing
// (the write queue, undo and redo, outside changes) goes through each graph's asset document:
// `shaderGraphDocument(project, path)`, over the formats the plugin registers.
import { signal } from "@preact/signals";
import { defaultShaderGraph, defaultShaderSubGraph, formatShaderGraph, isShaderSubGraphPath, type ShaderGraph } from "../../../engine/scene/shaderGraph";
import { defaultMaterialSettings } from "../../../engine/scene/material";
import { fileName } from "../../../editor/assetBrowser";
import { openAssetDocument, type AssetDocument } from "../../../editor/assetDocuments";
import { freePath } from "../../../editor/assetOps";
import { showPanel } from "../../../editor/layout/store";
import { writeMaterial } from "./materialAssets";
import { errorStatus } from "../../../editor/messages";
import type { EditorProject } from "../../../editor/projects";
import { shaderGraphFormat, shaderSubgraphFormat } from "./shaderGraphFormat";
import { currentProject, docVersion, status } from "../../../editor/state";

/** The shader graph open in the Shader Graph panel, or null. */
export const openShaderGraph = signal<string | null>(null);

/** Open a graph in the Shader Graph panel and bring the panel forward. */
export function openShaderGraphAsset(path: string): void {
  openShaderGraph.value = path;
  showPanel("shadergraph");
}

/** The format id of the graph at `path`: a sub-graph or a shader graph. */
export const shaderGraphFormatId = (path: string): "shadergraph" | "shadersubgraph" => (isShaderSubGraphPath(path) ? "shadersubgraph" : "shadergraph");

/** The asset document editing the graph at `path`: its value, edits, undo and redo, saving. */
export const shaderGraphDocument = (project: EditorProject, path: string): AssetDocument<ShaderGraph> => openAssetDocument<ShaderGraph>(project, path, shaderGraphFormatId(path));

export interface ReadShaderGraph {
  graph: ShaderGraph;
  problems: string[];
}

/** A shader graph as its file holds it now. */
export function readShaderGraph(project: EditorProject, path: string): ReadShaderGraph {
  const read = (isShaderSubGraphPath(path) ? shaderSubgraphFormat : shaderGraphFormat).parse(project.assets.get(path), path);
  return { graph: read.value, problems: read.problems.map((p) => p.message) };
}

/** Replace a graph through its document (one undo step) and wait for the write. Throws for a read-only project. */
export function writeShaderGraph(project: EditorProject, path: string, graph: ShaderGraph): Promise<void> {
  if (!project.canSave) return Promise.reject(new Error(`${project.name} is read-only.`));
  const doc = shaderGraphDocument(project, path);
  doc.edit(graph);
  return doc.flush();
}

/** Where New Shader Graph goes by default: `shaders/` if the project has it, else the folder given. */
export function shaderGraphFolder(folder: string): string {
  return folder === "" && currentProject.value?.folders.includes("shaders") ? "shaders" : folder;
}

const readOnly = (project: EditorProject, what: string) => {
  status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add ${what}.` };
};

/** Create `New Shader Graph.shadergraph.json` in `folder`. Returns its path, or null. */
export const createShaderGraph = (folder: string) => createGraphFile(folder, "New Shader Graph.shadergraph.json", defaultShaderGraph(), "shader graphs");

/** Create `New Sub Graph.shadersubgraph.json` in `folder` (ADR 0048). Returns its path, or null. */
export const createShaderSubGraph = (folder: string) => createGraphFile(folder, "New Sub Graph.shadersubgraph.json", defaultShaderSubGraph(), "sub-graphs");

async function createGraphFile(folder: string, name: string, graph: ShaderGraph, what: string): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    readOnly(project, what);
    return null;
  }
  const path = freePath(project, shaderGraphFolder(folder), name);
  try {
    await project.writeText(path, formatShaderGraph(graph));
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${fileName(path)}.` };
  return path;
}

/** Create a material that draws with `graphPath`, beside it. Returns its path, or null. */
export async function createMaterialForGraph(graphPath: string): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    readOnly(project, "materials");
    return null;
  }
  const folder = graphPath.includes("/") ? graphPath.slice(0, graphPath.lastIndexOf("/")) : "";
  const base = fileName(graphPath).replace(/\.shadergraph\.json$/i, "");
  const path = freePath(project, folder, `${base}.material.json`);
  try {
    await writeMaterial(project, path, { ...defaultMaterialSettings(), shader: `asset:${graphPath}` });
  } catch (err) {
    status.value = errorStatus(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  status.value = { kind: "info", text: `Created ${fileName(path)}, drawn with ${fileName(graphPath)}.` };
  return path;
}
