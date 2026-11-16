import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../../engine";
import { Assets, Engine } from "../../../engine";
import { loadNavigation } from "../../../engine/nav/loader";
import { bakeAllFromPanel, bakeOpenSceneChunk, checkNavInputs, isNavBakeStale, navChunkState, lookUpNavRecord } from "./navBake";
import { navPolyCount, navRecordPath, withBakeReference } from "./navBakeFiles";
import { MemoryFileSystem } from "../../../editor/memoryFs";
import { openSceneFile } from "../../../editor/project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "../../../editor/projects";
import { openScene, status } from "../../../editor/state";
import type { SceneFile } from "../../../engine/scene/SceneLoader";

// Baking navigation in the editor (ADR 0065): a NavChunk bakes from a World into `<scene>.nav.bin`, with a
// record of its inputs for the stale notice; Bake All bakes every scene and points chunks at their files.

const ROOT = "C:\\Games\\nav";
const scene = (extra: SceneFile["nodes"] = []): string =>
  JSON.stringify({
    format: "myco.scene@4",
    nodes: [
      { id: "nav", name: "Navigation", components: [{ type: "engine.Transform", data: {} }, { type: "engine.NavChunk", data: {} }] },
      { id: "ground", name: "Ground", components: [{ type: "engine.Transform", data: {} }, { type: "engine.MeshRenderer", data: { mesh: "builtin:plane" } }] },
      ...extra,
    ],
  });

async function project() {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), '{ "name": "Nav" }\n');
  fs.files.set(joinPath(ROOT, "scenes/a.scene.json"), scene());
  fs.files.set(joinPath(ROOT, "scenes/b.scene.json"), scene([{ id: "box", name: "Box", components: [{ type: "engine.Transform", data: { position: [0, 0.5, 0] } }, { type: "engine.BoxCollider", data: {} }] }]));
  fs.files.set(joinPath(ROOT, "scenes/empty.scene.json"), JSON.stringify({ format: "myco.scene@4", nodes: [] }));
  const p = await openFolderProject(fs, ROOT);
  useProjectAssets(p);
  return { fs, p };
}

describe("editor navigation bake", () => {
  let engine: Engine | null = null;
  beforeEach(() => {
    Assets.clearSources();
  });
  afterEach(() => {
    openScene.value = null;
    engine?.dispose();
    engine = null;
    status.value = null;
  });

  /** Open `path` of `p` in the editor; returns the open scene. */
  async function openIn(p: EditorProject, path: string) {
    engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(p) });
    openSceneFile(engine, path);
    return openScene.value!;
  }

  it("bakes a chunk into the scene's .nav.bin, records its inputs, and notices when they change", async () => {
    const { fs, p } = await project();
    const open = await openIn(p, "scenes/a.scene.json");
    const world = open.sync.world, chunk = open.sync.nodeFor("nav")!;
    await bakeOpenSceneChunk(open, "nav", p);
    expect(status.value?.text).toMatch(/^Baked Navigation: scenes\/a\.nav\.bin/);
    expect(open.doc.fieldValue("nav", "engine.NavChunk", "bake")).toBe("asset:scenes/a.nav.bin"); // pointed at its file, in the open scene
    const outcome = { record: navChunkState("scenes/a.scene.json", "nav").record! };
    const bytes = fs.files.get(joinPath(ROOT, "scenes/a.nav.bin"));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(p.files).toContain("scenes/a.nav.bin");
    expect(p.sizeOf("scenes/a.nav.bin")).toBe((bytes as Uint8Array).length);
    const nav = await loadNavigation();
    const info = JSON.parse(nav.bakeInfo(bytes as Uint8Array, true));
    expect(info.error).toBeUndefined();
    expect(info.signature).toBe(outcome.record.report.signature);
    expect(navPolyCount(outcome.record.report)).toBeGreaterThan(0);

    // The record is kept out of the project's files, in .myco/nav/.
    const record = JSON.parse(fs.files.get(joinPath(ROOT, navRecordPath("scenes/a.nav.bin"))) as string);
    expect(record).toMatchObject({ format: "myco.navbake@1", chunkNodeId: "nav", asset: "scenes/a.nav.bin", inputSignature: outcome.record.inputSignature });
    expect(p.files.some((f) => f.startsWith(".myco"))).toBe(false);

    const s = navChunkState("scenes/a.scene.json", "nav");
    expect(s.stage).toBeNull();
    expect(isNavBakeStale(s)).toBe(false);
    await checkNavInputs(p, "scenes/a.scene.json", world, chunk);
    expect(isNavBakeStale(s)).toBe(false);
    open.sync.nodeFor("ground")!.transform!.position.y = 1;
    await checkNavInputs(p, "scenes/a.scene.json", world, chunk);
    expect(isNavBakeStale(s)).toBe(true);

    // A fresh session (the project opened again) finds the record on disk.
    const again = await openFolderProject(fs, ROOT);
    await lookUpNavRecord(again, "scenes/a.scene.json", chunk);
    expect(navChunkState("scenes/a.scene.json", "nav").record?.inputSignature).toBe(outcome.record.inputSignature);
  });

  it("refuses to bake a read-only project", async () => {
    const { fs, p } = await project();
    const open = await openIn(p, "scenes/a.scene.json");
    const readOnly = Object.create(p, { canSave: { value: false } });
    await bakeOpenSceneChunk(open, "nav", readOnly);
    expect(status.value).toMatchObject({ kind: "error", text: expect.stringMatching(/Couldn't bake Navigation/) });
    expect(status.value?.detail ?? status.value?.text).toMatch(/read-only/);
    expect(fs.files.has(joinPath(ROOT, "scenes/a.nav.bin"))).toBe(false);
    await bakeAllFromPanel(readOnly);
    expect(status.value?.text).toMatch(/read-only/);
  });

  it("Bake All bakes every scene with a NavChunk and points each chunk at its file", async () => {
    const { fs, p } = await project();
    await bakeAllFromPanel(p);
    expect(status.value).toMatchObject({ kind: "info", text: "Baked 2 navigation chunks." });
    expect(fs.files.get(joinPath(ROOT, "scenes/b.nav.bin"))).toBeInstanceOf(Uint8Array);
    const b = JSON.parse(fs.files.get(joinPath(ROOT, "scenes/b.scene.json")) as string) as SceneFile;
    expect(b.nodes[0].components?.find((c) => c.type === "engine.NavChunk")?.data).toEqual({ bake: "asset:scenes/b.nav.bin" });
    // Baking again finds the reference set, and leaves the scene file alone.
    const writes = fs.writes.length;
    status.value = null;
    await bakeAllFromPanel(p);
    expect(status.value).toMatchObject({ kind: "info", text: "Baked 2 navigation chunks." });
    expect(fs.writes.slice(writes).filter((w) => w.endsWith(".scene.json"))).toEqual([]);
  });

  it("points a scene file's NavChunk at a bake file", () => {
    const file = JSON.parse(scene()) as SceneFile;
    const next = withBakeReference(file, "nav", "scenes/a.nav.bin")!;
    expect(next.nodes[0].components![1].data).toEqual({ bake: "asset:scenes/a.nav.bin" });
    expect(file.nodes[0].components![1].data).toEqual({});
    expect(withBakeReference(file, "ground", "x.nav.bin")).toBeNull();
  });
});
