// Shader graph assets in the editor (ADR 0046, 0047; the Materials plugin since 0134): creating
// `*.shadergraph.json` files, reading them, and which one the Shader Graph panel has open. Editing
// (the write queue, undo and redo, outside changes) goes through each graph's asset document:
// `shaderGraphDocument(project, path)`, over the formats the plugin registers.
import { signal } from "@preact/signals";
import { defaultShaderGraph, defaultShaderSubGraph, formatShaderGraph, isShaderSubGraphPath, type ShaderGraph } from "../../../engine/scene/shaderGraph";
import { defaultMaterialSettings } from "../../../engine/scene/material";
import { writeMaterial } from "./materialAssets";
import { shaderGraphFormat, shaderSubgraphFormat } from "./shaderGraphFormat";
import { editor, openAssetDocument, type AssetDocument, type EditorProject } from "../../../editor/sdk";

/** The shader graph open in the Shader Graph panel, or null. */
export const openShaderGraph = signal<string | null>(null);

/** Open a graph in the Shader Graph panel and bring the panel forward. */
export function openShaderGraphAsset(path: string): void {
  openShaderGraph.value = path;
  editor.showPanel("shadergraph");
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
  return folder === "" && editor.project.current?.folders.includes("shaders") ? "shaders" : folder;
}

/** Create `New Shader Graph.shadergraph.json` in `folder`. Returns its path, or null. */
export const createShaderGraph = (folder: string) => createGraphFile(folder, "New Shader Graph.shadergraph.json", defaultShaderGraph(), "shader graphs");

/** Create `New Sub Graph.shadersubgraph.json` in `folder` (ADR 0048). Returns its path, or null. */
export const createShaderSubGraph = (folder: string) => createGraphFile(folder, "New Sub Graph.shadersubgraph.json", defaultShaderSubGraph(), "sub-graphs");

function createGraphFile(folder: string, name: string, graph: ShaderGraph, what: string): Promise<string | null> {
  return editor.project.createFile({ folder: shaderGraphFolder(folder), name, what, write: (project, path) => project.writeText(path, formatShaderGraph(graph)) });
}

/** Create a material that draws with `graphPath`, beside it. Returns its path, or null. */
export function createMaterialForGraph(graphPath: string): Promise<string | null> {
  const base = editor.assets.fileName(graphPath).replace(/\.shadergraph\.json$/i, "");
  return editor.project.createFile({
    folder: editor.assets.folderOf(graphPath),
    name: `${base}.material.json`,
    what: "materials",
    write: (project, path) => writeMaterial(project, path, { ...defaultMaterialSettings(), shader: `asset:${graphPath}` }),
    created: (path) => `Created ${editor.assets.fileName(path)}, drawn with ${editor.assets.fileName(graphPath)}.`,
  });
}
