// Particle assets edited through asset documents (ADR 0134): one write per edit, a drag or gesture
// is one undo step, an edit that changes nothing makes none, view changes stay out of undo, and the
// history follows a rename.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultParticleGraph, formatParticleGraph } from "../../../engine/scene/particleGraphFormat";
import { _reset } from "../../../editor/assetDocuments";
import { moveAssets } from "../../../editor/assetOps";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { useEditorPlugins } from "../../testEditorPlugins";
import { currentProject, status } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { particlesEditorPlugin } from ".";
import { createParticleBlock, createParticleSubgraph, particleDocument, particleFormatId, readEffect, writeEffect } from "./particleAssets";
import { formatAsset, subgraphTemplate } from "./particleGraph/assetDocs";
import { addNote, moveItems, setSystemCollapsed, updateNote } from "./particleGraph/graphEdit";

const FX = "effects/a.particles.json";
const SUB = "effects/b.particlesubgraph.json";
let fs: MemoryFileSystem;
let project: EditorProject;
const onDisk = (path: string) => fs.files.get(joinPath(ROOT, path));

useEditorPlugins([particlesEditorPlugin], "each");
beforeEach(async () => {
  fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, FX), formatParticleGraph(defaultParticleGraph()));
  fs.files.set(joinPath(ROOT, SUB), formatAsset(subgraphTemplate()));
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
});
afterEach(() => {
  _reset();
  currentProject.value = null;
  status.value = null;
});

/** Count the project's writes. */
function countWrites(): string[] {
  const writes: string[] = [];
  const write = project.writeText.bind(project);
  project.writeText = async (path, text) => {
    writes.push(path);
    await write(path, text);
  };
  return writes;
}

describe("particle documents (ADR 0134)", () => {
  it("open effects, sub-graphs and blocks with their own format", () => {
    expect([particleFormatId(FX), particleFormatId(SUB), particleFormatId("x.particleblock.json")]).toEqual(["particles", "particlesubgraph", "particleblock"]);
    expect(particleDocument(project, FX).value.value.systems.length).toBeGreaterThan(0);
    expect(particleDocument(project, SUB).value.value.nodes.some((n) => n.type === "asset.input")).toBe(true);
  });

  it("write an edit once", async () => {
    const doc = particleDocument(project, FX);
    const writes = countWrites();
    const next = addNote(doc.value.value, [10, 20]).graph;
    doc.edit(next);
    await doc.flush();
    expect(writes).toEqual([FX]);
    expect(onDisk(FX)).toBe(formatParticleGraph(next));
    expect(readEffect(project, FX).graph.notes).toHaveLength(1);
  });

  it("make a drag one undo step and one write", async () => {
    const doc = particleDocument(project, FX);
    const start = doc.value.value;
    const id = start.systems[0]!.id;
    const writes = countWrites();
    for (let x = 1; x <= 5; x++) doc.edit(moveItems(doc.value.peek(), new Map([[id, [x * 10, 0]]])), { coalesce: true });
    await doc.flush();
    expect(writes).toEqual([FX]);
    expect(JSON.parse(onDisk(FX) as string).systems[0].position).toEqual([50, 0]);
    doc.undo();
    expect(doc.canUndo.value).toBe(false);
    expect(doc.value.value).toEqual(start);
    doc.redo();
    expect(doc.value.value.systems[0]!.position).toEqual([50, 0]);
  });

  it("add no undo step for an edit that changes nothing (a note patched to what it holds)", async () => {
    const doc = particleDocument(project, FX);
    await writeEffect(project, FX, addNote(doc.value.value, [0, 0]).graph);
    doc.undo();
    doc.redo();
    await doc.flush();
    const g = doc.value.value;
    const note = g.notes[0]!;
    expect(updateNote(g, note.id, { position: note.position, text: note.text })).toBe(g);
    const before = doc.canUndo.value;
    const writes = countWrites();
    doc.edit(updateNote(g, note.id, { position: note.position }));
    doc.edit({ ...g });
    await doc.flush();
    expect(writes).toEqual([]);
    expect(doc.canUndo.value).toBe(before);
    doc.undo();
    expect(doc.canUndo.value).toBe(false);
  });

  it("save a collapsed frame without an undo step", async () => {
    const doc = particleDocument(project, FX);
    const id = doc.value.value.systems[0]!.id;
    doc.edit(setSystemCollapsed(doc.value.value, id, true), { history: false });
    await doc.flush();
    expect(doc.canUndo.value).toBe(false);
    expect(JSON.parse(onDisk(FX) as string).editor.collapsed).toEqual([id]);
  });

  it("keep an effect's history through a rename", async () => {
    const doc = particleDocument(project, FX);
    const start = doc.value.value;
    await writeEffect(project, FX, addNote(start, [0, 0]).graph);
    const to = "effects/c.particles.json";
    expect(await moveAssets([[FX, to]])).toBe(true);
    expect(particleDocument(project, to)).toBe(doc);
    doc.undo();
    await doc.flush();
    expect(onDisk(to)).toBe(formatParticleGraph(start));
    expect(onDisk(FX)).toBeUndefined();
  });

  it("follow a change made elsewhere", async () => {
    const doc = particleDocument(project, FX);
    const changed = addNote(defaultParticleGraph(), [5, 5]).graph;
    await project.writeText(FX, formatParticleGraph(changed));
    const { docVersion } = await import("../../../editor/state");
    docVersion.value++;
    expect(doc.value.value.notes).toHaveLength(1);
  });

  it("refuse edits in a read-only project", async () => {
    Object.defineProperty(project, "canSave", { value: false });
    const doc = particleDocument(project, FX);
    doc.edit(addNote(doc.value.value, [0, 0]).graph);
    expect(doc.value.value.notes).toHaveLength(0);
    await expect(writeEffect(project, FX, defaultParticleGraph())).rejects.toThrow(/read-only/);
  });
});

describe("New Particle Sub-graph and Block", () => {
  it("create parseable assets beside effects", async () => {
    const sub = await createParticleSubgraph("");
    const block = await createParticleBlock("");
    expect(sub).toBe("effects/New Particle Sub-graph.particlesubgraph.json");
    expect(block).toBe("effects/New Particle Block.particleblock.json");
    expect(readEffect(project, sub!).problems).toEqual([]);
    expect(readEffect(project, block!).problems).toEqual([]);
  });
});
