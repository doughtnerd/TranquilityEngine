import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultShaderGraph, defaultShaderSubGraph, formatShaderGraph } from "../../../engine/scene/shaderGraph";
import { useEditorPlugins } from "../../testEditorPlugins";
import { materialsEditorPlugin } from ".";
import { moveAssets } from "../../../editor/assetOps";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { assetKinds } from "../../../editor/sdk/contributions";
import { editor } from "../../../editor/sdk";
import type { ShaderGraph } from "../../../engine/scene/shaderGraph";
import { addNode, moveNodes } from "./shaderGraph/graphEdit";
import { shaderGraphDocument } from "./shaderGraphAssets";
import { shaderGraphFormat, shaderSubgraphFormat } from "./shaderGraphFormat";
import { currentProject, status } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";

const PATH = "shaders/a.shadergraph.json";
const SUB = "shaders/b.shadersubgraph.json";
let fs: MemoryFileSystem;
let project: EditorProject;
const onDisk = (path: string) => fs.files.get(joinPath(ROOT, path));

beforeEach(async () => {
  fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, PATH), formatShaderGraph(defaultShaderGraph()));
  fs.files.set(joinPath(ROOT, SUB), formatShaderGraph(defaultShaderSubGraph()));
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
});

// The formats come from the Materials plugin (ADR 0134).
useEditorPlugins([materialsEditorPlugin], "each");
afterEach(() => {
  vi.useRealTimers();
  currentProject.value = null;
  status.value = null;
});

describe("shader graph formats (ADR 0134)", () => {
  it("are declared by their kinds", () => {
    expect(assetKinds.get("shadergraph")!.format).toBe(shaderGraphFormat);
    expect(assetKinds.get("shadersubgraph")!.format).toBe(shaderSubgraphFormat);
  });

  it("read a missing or foreign file as the kind's default graph with a problem", async () => {
    const missing = editor.assets.read<ShaderGraph>(project, "shaders/gone.shadergraph.json");
    expect(missing.value).toEqual(defaultShaderGraph());
    expect(missing.problems.length).toBe(1);
    await project.writeText("shaders/c.shadersubgraph.json", '{ "format": "nope" }');
    expect(editor.assets.read<ShaderGraph>(project, "shaders/c.shadersubgraph.json").value.subgraph).toBeDefined();
    expect(editor.assets.read<ShaderGraph>(project, SUB).value.subgraph).toBeDefined();
  });

  it("round-trip a graph and a sub-graph", () => {
    const read = shaderSubgraphFormat.parse(JSON.parse(formatShaderGraph(defaultShaderSubGraph())), SUB);
    expect(read.problems).toEqual([]);
    expect(shaderSubgraphFormat.format(read.value)).toBe(formatShaderGraph(defaultShaderSubGraph()));
  });
});

describe("shader graph documents", () => {
  it("opens graphs and sub-graphs with their own format", () => {
    expect(shaderGraphDocument(project, PATH).value.value.subgraph).toBeUndefined();
    expect(shaderGraphDocument(project, SUB).value.value.subgraph).toBeDefined();
  });

  it("writes a graph edit once", async () => {
    const doc = shaderGraphDocument(project, PATH);
    const writes: string[] = [];
    const write = project.writeText.bind(project);
    project.writeText = async (path, text) => {
      writes.push(path);
      await write(path, text);
    };
    const next = addNode(doc.value.value, "time", [10, 20]).graph;
    doc.edit(next);
    await doc.flush();
    expect(writes).toEqual([PATH]);
    expect(onDisk(PATH)).toBe(formatShaderGraph(next));
    expect(editor.assets.read<ShaderGraph>(project, PATH).value.nodes.length).toBe(next.nodes.length);
  });

  it("adds no undo step for an edit that changes nothing", () => {
    const doc = shaderGraphDocument(project, PATH);
    doc.edit({ ...doc.value.value });
    expect(doc.canUndo.value).toBe(false);
  });

  it("makes a node drag one undo step, and undo restores the graph", async () => {
    const doc = shaderGraphDocument(project, PATH);
    const start = doc.value.value;
    const id = start.nodes[0].id;
    for (let x = 1; x <= 5; x++) doc.edit(moveNodes(doc.value.peek(), new Map([[id, [x * 10, 0]]])), { coalesce: true });
    await doc.flush();
    expect(JSON.parse(onDisk(PATH) as string).nodes[0].position).toEqual([50, 0]);
    doc.undo();
    expect(doc.canUndo.value).toBe(false);
    expect(doc.value.value).toEqual(start);
    await doc.flush();
    expect(onDisk(PATH)).toBe(formatShaderGraph(start));
    doc.redo();
    expect(doc.value.value.nodes[0].position).toEqual([50, 0]);
  });

  it("keeps a graph's history through a rename", async () => {
    const doc = shaderGraphDocument(project, PATH);
    const start = doc.value.value;
    doc.edit(addNode(start, "time", [0, 0]).graph);
    await doc.flush();
    const to = "shaders/c.shadergraph.json";
    expect(await moveAssets([[PATH, to]])).toBe(true);
    expect(shaderGraphDocument(project, to)).toBe(doc);
    doc.undo();
    await doc.flush();
    expect(onDisk(to)).toBe(formatShaderGraph(start));
    expect(onDisk(PATH)).toBeUndefined();
  });
});
