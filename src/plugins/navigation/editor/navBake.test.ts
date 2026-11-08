import { beforeEach, describe, expect, it } from "vitest";
import "../../../engine";
import { Assets } from "../../../engine";
import { loadNavigation } from "../../../engine/nav/loader";
import { inThreadRunner, bakeAllNavigation, bakeNavChunk, checkNavInputs, isNavBakeStale, navChunkState, resetNavBakeStates, scratchSceneWorld, setNavBakeRunner, lookUpNavRecord } from "./navBake";
import { navPolyCount, navRecordPath, withBakeReference } from "./navBakeFiles";
import { MemoryFileSystem } from "../../../editor/memoryFs";
import { joinPath, openFolderProject, useProjectAssets } from "../../../editor/projects";
import type { SceneFile } from "../../../engine/scene/SceneLoader";
import { findNavChunks } from "../../../engine/nav/geometry";

// Baking navigation in the editor (ADR 0065): a NavChunk bakes from a World into `<scene>.nav.bin`, with a
// record of its inputs for the stale notice; Bake All bakes every scene and points chunks at their files.

const ROOT = "C:\\Games\\nav";
const scene = (extra: SceneFile["nodes"] = []): string =>
  JSON.stringify({
    format: "myco.scene@1",
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
  fs.files.set(joinPath(ROOT, "scenes/empty.scene.json"), JSON.stringify({ format: "myco.scene@1", nodes: [] }));
  const p = await openFolderProject(fs, ROOT);
  useProjectAssets(p);
  return { fs, p };
}

describe("editor navigation bake", () => {
  beforeEach(() => {
    resetNavBakeStates();
    setNavBakeRunner(inThreadRunner);
    Assets.clearSources();
  });

  it("bakes a chunk into the scene's .nav.bin, records its inputs, and notices when they change", async () => {
    const { fs, p } = await project();
    const { world, scene: root } = scratchSceneWorld(p, "scenes/a.scene.json", p.assets.get("scenes/a.scene.json") as SceneFile);
    const [chunk] = findNavChunks(root);
    const outcome = await bakeNavChunk(p, "scenes/a.scene.json", world, chunk);
    expect(outcome.asset).toBe("scenes/a.nav.bin");
    expect(outcome.needsReference).toBe(true);
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
    root.children.find((n) => n.id === "ground")!.transform!.position.y = 1;
    await checkNavInputs(p, "scenes/a.scene.json", world, chunk);
    expect(isNavBakeStale(s)).toBe(true);

    // A fresh session finds the record on disk.
    resetNavBakeStates();
    await lookUpNavRecord(p, "scenes/a.scene.json", chunk);
    expect(navChunkState("scenes/a.scene.json", "nav").record?.inputSignature).toBe(outcome.record.inputSignature);
  });

  it("refuses to bake a read-only project", async () => {
    const { p } = await project();
    const { world, scene: root } = scratchSceneWorld(p, "scenes/a.scene.json", p.assets.get("scenes/a.scene.json") as SceneFile);
    const readOnly = Object.create(p, { canSave: { value: false } });
    await expect(bakeNavChunk(readOnly, "scenes/a.scene.json", world, findNavChunks(root)[0])).rejects.toThrow(/read-only/);
  });

  it("Bake All bakes every scene with a NavChunk and points each chunk at its file", async () => {
    const { fs, p } = await project();
    const result = await bakeAllNavigation(p);
    expect(result).toEqual({ baked: 2, failed: [] });
    expect(fs.files.get(joinPath(ROOT, "scenes/b.nav.bin"))).toBeInstanceOf(Uint8Array);
    const b = JSON.parse(fs.files.get(joinPath(ROOT, "scenes/b.scene.json")) as string) as SceneFile;
    expect(b.nodes[0].components?.find((c) => c.type === "engine.NavChunk")?.data).toEqual({ bake: "asset:scenes/b.nav.bin" });
    // Baking again finds the reference set, and leaves the scene file alone.
    const writes = fs.writes.length;
    expect(await bakeAllNavigation(p)).toEqual({ baked: 2, failed: [] });
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
