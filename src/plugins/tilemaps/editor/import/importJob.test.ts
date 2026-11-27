import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { tilemapsEditorPlugin } from "..";
import { useEditorPlugins } from "../../../testEditorPlugins";
import { assetKind } from "../../../../editor/assetBrowser";
import { joinPath, openFolderProject } from "../../../../editor/projects";
import { currentProject, status } from "../../../../editor/state";
import { MemoryFileSystem, ROOT, useCoreAssetKinds } from "../../../../editor/testing";
import { parseTileset } from "../../runtime/tileset";
import { loadImportSource, planImport, whyNotOutputFolder, writeImport } from "./importJob";

useCoreAssetKinds();
useEditorPlugins([tilemapsEditorPlugin]);
afterEach(() => (currentProject.value = null));

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** A disk as a real one behaves: any file reads as text or bytes. */
class Disk extends MemoryFileSystem {
  override async readText(p: string) {
    const v = this.files.get(p.replace(/\//g, "\\"));
    return v instanceof Uint8Array ? new TextDecoder().decode(v) : super.readText(p);
  }
}

/** A project holding the Tiled fixtures (sources as their bytes, the TSX under its real name) and their images. */
async function tiledProject() {
  const fs = new Disk();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  const bytes = async (fixture: string) => new Uint8Array(await readFile(FIXTURES + fixture));
  fs.files.set(joinPath(ROOT, "tiled/ortho.tmx"), await bytes("tiled/ortho.tmx"));
  fs.files.set(joinPath(ROOT, "tiled/terrain.tsx"), await bytes("tiled/terrain.tsx.xml"));
  fs.files.set(joinPath(ROOT, "tiled/objects/chest.tx"), await bytes("tiled/objects/chest.tx"));
  for (const img of ["terrain.png", "barrel.png", "crate.png", "sky.png"]) fs.files.set(joinPath(ROOT, `images/${img}`), new Uint8Array([137, 80, 78, 71]));
  const project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
  return { fs, project };
}

describe("importing Tiled and LDtk files in the editor (ADR 0436)", () => {
  it("knows the source kinds, and keeps a Tiled .tsx tileset in the project", async () => {
    expect(assetKind("levels/forest.tmx")).toBe("tiledmap");
    expect(assetKind("levels/forest.tmj")).toBe("tiledmap");
    expect(assetKind("levels/world.ldtk")).toBe("ldtkproject");
    expect(assetKind("tiles/ground.tsj")).toBe("tiledtileset");
    expect(assetKind("tiles/ground.tsx")).toBe("tiledtileset");
    const { project } = await tiledProject();
    expect(project.files).toContain("tiled/terrain.tsx");
  });

  it("plans the files, writes them in one batch with a status message, and lists what a re-import overwrites", async () => {
    const { fs, project } = await tiledProject();
    const source = await loadImportSource(project, "tiled/ortho.tmx");
    const plan = planImport(project, source, { folder: "levels/" });
    expect(plan.files.map((f) => f.path)).toEqual(["levels/terrain.tileset.json", "levels/props.tileset.json", "images/terrain.png.meta.json", "levels/ortho.prefab.json"]);
    expect(plan.overwrites).toEqual([]);
    expect(plan.sidecars).toEqual(["images/terrain.png.meta.json"]);
    const written = await writeImport(project, "tiled/ortho.tmx", plan);
    expect(written).toEqual(plan.files.map((f) => f.path));
    for (const p of written) expect(fs.files.has(joinPath(ROOT, p)), p).toBe(true);
    expect(project.files).toContain("levels/ortho.prefab.json");
    expect(status.value?.text).toMatch(/^Imported ortho\.tmx: wrote 4 files, \d+ warnings?\.$/);
    const uuids = parseTileset(project.assets.get("levels/terrain.tileset.json"), "t").tileset.tiles.map((t) => t.uuid);

    // Again: the generated files are overwritten (the dialog asks first), the sidecar needs nothing, uuids stay.
    const again = planImport(project, await loadImportSource(project, "tiled/ortho.tmx"), { folder: "levels" });
    expect(again.overwrites).toEqual(["levels/terrain.tileset.json", "levels/props.tileset.json", "levels/ortho.prefab.json"]);
    expect(again.sidecars).toEqual([]);
    await writeImport(project, "tiled/ortho.tmx", again);
    expect(parseTileset(project.assets.get("levels/terrain.tileset.json"), "t").tileset.tiles.map((t) => t.uuid)).toEqual(uuids);
  });

  it("refuses an output folder outside the project", () => {
    expect(whyNotOutputFolder("levels/forest")).toBeNull();
    expect(whyNotOutputFolder("")).toBeNull();
    expect(whyNotOutputFolder("../elsewhere")).toMatch(/inside the project/);
    expect(whyNotOutputFolder("C:/Games")).toMatch(/inside the project/);
  });
});
