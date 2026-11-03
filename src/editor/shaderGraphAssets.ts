// Shader graph assets in the editor (ADR 0046, 0047): creating `*.shadergraph.json` files,
// reading and writing them, which one the Shader Graph panel has open, and each graph's undo
// history for the session.
import { signal } from "@preact/signals";
import { defaultShaderGraph, formatShaderGraph, parseShaderGraph, type ShaderGraph } from "../engine/scene/shaderGraph";
import { defaultMaterialSettings } from "../engine/scene/material";
import { fileName } from "./assetBrowser";
import { freePath } from "./assetOps";
import { showPanel } from "./layout/store";
import { writeMaterial } from "./materialAssets";
import { errorStatus } from "./messages";
import type { EditorProject } from "./projects";
import { currentProject, docVersion, status } from "./state";

/** The shader graph open in the Shader Graph panel, or null. */
export const openShaderGraph = signal<string | null>(null);

/** Open a graph in the Shader Graph panel and bring the panel forward. */
export function openShaderGraphAsset(path: string): void {
  openShaderGraph.value = path;
  showPanel("shadergraph");
}

export interface ReadShaderGraph {
  graph: ShaderGraph;
  problems: string[];
}

/** A shader graph as its file holds it now. */
export function readShaderGraph(project: EditorProject, path: string): ReadShaderGraph {
  try {
    return parseShaderGraph(project.assets.get(path), path);
  } catch (err) {
    return { graph: defaultShaderGraph(), problems: [(err as Error).message] };
  }
}

/** Each graph's writes in progress, so saves land in order. */
const writing = new Map<string, Promise<unknown>>();

/** Write a graph after the writes before it. Throws for a read-only project. */
export function writeShaderGraph(project: EditorProject, path: string, graph: ShaderGraph): Promise<void> {
  const text = formatShaderGraph(graph);
  const run = () => project.writeText(path, text);
  const result = (writing.get(path) ?? Promise.resolve()).then(run, run);
  const settled = result.catch(() => undefined);
  writing.set(path, settled);
  void settled.then(() => writing.get(path) === settled && writing.delete(path));
  return result;
}

/** Undo and redo for one graph: the graphs before and after the current one. */
export interface GraphHistory {
  undo: ShaderGraph[];
  redo: ShaderGraph[];
}

const HISTORY_LIMIT = 200;
const histories = new Map<string, GraphHistory>();

/** A graph's history this session (kept while the panel shows another graph). */
export function graphHistory(path: string): GraphHistory {
  let h = histories.get(path);
  if (!h) histories.set(path, (h = { undo: [], redo: [] }));
  return h;
}

/** Record that the graph was `before` until an edit. */
export function recordEdit(path: string, before: ShaderGraph): void {
  const h = graphHistory(path);
  h.undo.push(before);
  if (h.undo.length > HISTORY_LIMIT) h.undo.shift();
  h.redo.length = 0;
}

/** Forget a graph's history (its file was renamed or deleted). */
export const forgetGraphHistory = (path: string) => histories.delete(path);

/** Where New Shader Graph goes by default: `shaders/` if the project has it, else the folder given. */
export function shaderGraphFolder(folder: string): string {
  return folder === "" && currentProject.value?.folders.includes("shaders") ? "shaders" : folder;
}

const readOnly = (project: EditorProject, what: string) => {
  status.value = { kind: "info", text: `${project.name} is read-only. Open a project folder (or copy the sample) to add ${what}.` };
};

/** Create `New Shader Graph.shadergraph.json` in `folder`. Returns its path, or null. */
export async function createShaderGraph(folder: string): Promise<string | null> {
  const project = currentProject.value;
  if (!project) return null;
  if (!project.canSave) {
    readOnly(project, "shader graphs");
    return null;
  }
  const path = freePath(project, shaderGraphFolder(folder), "New Shader Graph.shadergraph.json");
  try {
    await project.writeText(path, formatShaderGraph(defaultShaderGraph()));
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
