import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultShaderGraph, defaultShaderSubGraph, formatShaderGraph } from "../../../engine/scene/shaderGraph";
import { _reset } from "../../../editor/assetDocuments";
import { useEditorPlugins } from "../../testEditorPlugins";
import { materialsEditorPlugin } from ".";
import { moveAssets } from "../../../editor/assetOps";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { assetFormats } from "../../../editor/sdk/contributions";
import { addNode, moveNodes } from "./shaderGraph/graphEdit";
import { readShaderGraph, shaderGraphDocument, writeShaderGraph } from "./shaderGraphAssets";
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
  _reset();
  vi.useRealTimers();
  currentProject.value = null;
  status.value = null;
});

describe("shader graph formats (ADR 0134)", () => {
  it("are registered once, by kind", () => {
    expect(assetFormats.get("shadergraph")).toBe(shaderGraphFormat);
    expect(assetFormats.get("shadersubgraph")).toBe(shaderSubgraphFormat);
  });

  it("never throw: a missing or foreign file is the default graph with a problem", () => {
    const missing = shaderGraphFormat.parse(undefined, PATH);
    expect(missing.value).toEqual(defaultShaderGraph());
    expect(missing.problems.length).toBe(1);
    expect(shaderSubgraphFormat.parse({ format: "nope" }, SUB).value.subgraph).toBeDefined();
    expect(readShaderGraph(project, SUB).graph.subgraph).toBeDefined();
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
    expect(readShaderGraph(project, PATH).graph.nodes.length).toBe(next.nodes.length);
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
    await writeShaderGraph(project, PATH, addNode(start, "time", [0, 0]).graph);
    const to = "shaders/c.shadergraph.json";
    expect(await moveAssets([[PATH, to]])).toBe(true);
    expect(shaderGraphDocument(project, to)).toBe(doc);
    doc.undo();
    await doc.flush();
    expect(onDisk(to)).toBe(formatShaderGraph(start));
    expect(onDisk(PATH)).toBeUndefined();
  });
});
