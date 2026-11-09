// Import settings sidecars in the editor (ADR 0040): asset operations carry them, slice
// references follow renames and deletes, and reading and writing them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { parseImportSettings } from "../engine/scene/importSettings";
import { assetKind, listedFiles } from "./assetBrowser";
import { isSliceEntry, splitSliceEntry } from "./assetEntry";
import { nodeForAsset } from "./assetNodes";
import { deleteAssets } from "./assetDelete";
import { assetUsers } from "./assetReferences";
import { readImportSettings, writeImportSettings } from "./assetImport";
import { assetClipboard, copyAssets, duplicateAssets, moveAssetsTo, pasteAssets, renameAsset, renameSliceReferences } from "./assetOps";
import { OrbitCamera } from "./OrbitCamera";
import { askBeforeDeletingAssets } from "./preferences";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { replaceScripts } from "./scriptLoader";
import { currentProject, openScene, sceneCamera } from "./state";
import { MemoryFileSystem, ROOT, demoFolder, useCoreAssetKinds } from "./testing";
import { showSceneSettings } from "./inspectorTarget";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

let fs: MemoryFileSystem;
let project: EditorProject;
const onDisk = (path: string) => fs.files.get(joinPath(ROOT, path));

const SHEET_META = JSON.stringify({
  format: "myco.import@1",
  filter: "point",
  sprites: [
    { name: "a", rect: [0, 0, 2, 2], pivot: [0.5, 0.5] },
    { name: "b", rect: [2, 0, 2, 2], pivot: [0.5, 0] },
  ],
});
const USES_SLICE = JSON.stringify({
  format: "myco.scene@1",
  nodes: [{ id: "s", name: "S", components: [{ type: "engine.Transform" }, { type: "engine.SpriteRenderer", data: { sprite: "asset:images/PipeUp.png#b" } }] }],
});

beforeEach(async () => {
  Input.reset();
  fs = demoFolder();
  fs.files.set(joinPath(ROOT, "images/PipeUp.png.meta.json"), SHEET_META);
  fs.files.set(joinPath(ROOT, "prefabs/slice.prefab.json"), USES_SLICE);
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
  askBeforeDeletingAssets.value = false;
});

afterEach(async () => {
  askBeforeDeletingAssets.value = true;
  assetClipboard.value = null;
  showSceneSettings(); // clears every selection
  await replaceScripts(new Map());
});

describe("reading and writing import settings", () => {
  it("reads the sidecar, or the defaults when there's none", () => {
    expect(readImportSettings(project, "images/PipeUp.png")).toMatchObject({ exists: true, problems: [] });
    expect(readImportSettings(project, "images/PipeUp.png").settings.sprites.map((s) => s.name)).toEqual(["a", "b"]);
    expect(readImportSettings(project, "images/PipeDown.png")).toMatchObject({ exists: false, settings: { filter: "linear", sprites: [] } });
  });

  it("writes the sidecar beside the file, and the project serves the new settings", async () => {
    const { settings } = readImportSettings(project, "images/PipeDown.png");
    await writeImportSettings(project, "images/PipeDown.png", { ...settings, pixelsPerUnit: 16, filter: "point" });
    expect(JSON.parse(onDisk("images/PipeDown.png.meta.json") as string)).toEqual({ format: "myco.import@1", pixelsPerUnit: 16, filter: "point" });
    expect(project.files).toContain("images/PipeDown.png.meta.json");
    expect(readImportSettings(project, "images/PipeDown.png").settings.pixelsPerUnit).toBe(16);
  });

  it("reports a broken sidecar", () => {
    fs.files.set(joinPath(ROOT, "x.png.meta.json"), "{}");
    expect(readImportSettings({ ...project, files: [...project.files, "x.png.meta.json"], assets: { has: () => true, get: () => ({ format: "other" }) } } as EditorProject, "x.png").problems[0]).toMatch(/unknown format/);
  });
});

describe("the Assets panel's view of sidecars and slices", () => {
  it("hides sidecars, and treats slice entries as sprites that become sprite nodes", () => {
    expect(listedFiles(project.files)).not.toContain("images/PipeUp.png.meta.json");
    expect(listedFiles(project.files)).toContain("images/PipeUp.png");
    expect(assetKind("images/PipeUp.png#a")).toBe("sprite");
    expect(isSliceEntry("images/PipeUp.png#a")).toBe(true);
    expect(isSliceEntry("music/town.mp3")).toBe(false);
    expect(splitSliceEntry("images/PipeUp.png#a")).toEqual({ image: "images/PipeUp.png", slice: "a" });
    const entry = nodeForAsset(openScene.value!.doc, "images/PipeUp.png#walk_left", { position: [1, 2, 0] })!;
    expect(entry.name).toBe("Walk_left"); // capitalized, like nodes from file names
    expect(entry.id).toBe("walk-left");
    expect(entry.components![1]).toEqual({ type: "engine.SpriteRenderer", data: { sprite: "asset:images/PipeUp.png#walk_left" } });
  });
});

describe("asset operations carry sidecars", () => {
  it("renaming takes the sidecar along and updates slice references", async () => {
    expect(await renameAsset("images/PipeUp.png", "sheet.png")).toBe(true);
    expect(onDisk("images/PipeUp.png.meta.json")).toBeUndefined();
    expect(onDisk("images/sheet.png.meta.json")).toBe(SHEET_META);
    expect(project.files).toContain("images/sheet.png.meta.json");
    expect(project.files).not.toContain("images/PipeUp.png.meta.json");
    expect(onDisk("prefabs/slice.prefab.json")).toContain('"asset:images/sheet.png#b"');
  });

  it("moving into a folder takes the sidecar along", async () => {
    expect(await moveAssetsTo(["images/PipeUp.png"], "music")).toBe(true);
    expect(onDisk("music/PipeUp.png.meta.json")).toBe(SHEET_META);
    expect(onDisk("prefabs/slice.prefab.json")).toContain('"asset:music/PipeUp.png#b"');
  });

  it("a stray sidecar at the new name is replaced, not adopted", async () => {
    fs.files.set(joinPath(ROOT, "images/stray.png.meta.json"), "{}");
    project = await openFolderProject(fs, ROOT);
    useProjectAssets(project);
    currentProject.value = project;
    expect(await renameAsset("images/PipeDown.png", "stray.png")).toBe(true);
    expect(onDisk("images/stray.png.meta.json")).toBeUndefined();
    expect(await renameAsset("images/PipeUp.png", "PipeDown.png")).toBe(true);
    expect(onDisk("images/PipeDown.png.meta.json")).toBe(SHEET_META);
  });

  it("duplicating, copying and pasting copy the sidecar", async () => {
    expect(await duplicateAssets(["images/PipeUp.png"])).toEqual(["images/PipeUp copy.png"]);
    expect(onDisk("images/PipeUp copy.png.meta.json")).toBe(SHEET_META);
    assetClipboard.value = { entries: ["images/PipeUp.png"], cut: false };
    expect(await pasteAssets("music")).toEqual(["music/PipeUp.png"]);
    expect(onDisk("music/PipeUp.png.meta.json")).toBe(SHEET_META);
    // A folder copies each sidecar once, with its file.
    expect(await copyAssets(["images/"], "")).toEqual(["images copy/"]);
    expect(onDisk("images copy/PipeUp.png.meta.json")).toBe(SHEET_META);
    expect(onDisk("images copy/PipeUp copy.png.meta.json")).toBe(SHEET_META);
  });

  it("deleting an image deletes its sidecar, lists slice users, and removes slice references", async () => {
    expect(assetUsers(project, "images/PipeUp.png")).toContain("prefabs/slice.prefab.json");
    expect(await deleteAssets(["images/PipeUp.png"])).toBe(true);
    expect(onDisk("images/PipeUp.png.meta.json")).toBeUndefined();
    expect(project.files).not.toContain("images/PipeUp.png.meta.json");
    expect(onDisk("prefabs/slice.prefab.json")).not.toContain("PipeUp.png");
  });
});

describe("renaming slices", () => {
  it("points references at the new slice names", async () => {
    const { settings } = readImportSettings(project, "images/PipeUp.png");
    settings.sprites[1].name = "walk";
    await writeImportSettings(project, "images/PipeUp.png", settings);
    expect(await renameSliceReferences(project, "images/PipeUp.png", [["b", "walk"]])).toEqual(["prefabs/slice.prefab.json"]);
    expect(onDisk("prefabs/slice.prefab.json")).toContain('"asset:images/PipeUp.png#walk"');
    expect(parseImportSettings(JSON.parse(onDisk("images/PipeUp.png.meta.json") as string)).settings.sprites[1].name).toBe("walk");
  });
});
