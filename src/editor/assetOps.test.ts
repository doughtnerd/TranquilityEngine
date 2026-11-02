import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, SpriteRenderer } from "../engine";
import { deleteAssets } from "./assetDelete";
import { assetClipboard, copyAssets, duplicateAssets, freePath, moveAssets, moveAssetsTo, newFolder, pasteAssets, renameAsset, splitExtension, whyNotMoveTarget, whyNotValidName } from "./assetOps";
import { OrbitCamera } from "./OrbitCamera";
import { askBeforeDeletingAssets } from "./preferences";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { replaceScripts } from "./scriptLoader";
import { currentProject, openScene, sceneCamera, status } from "./state";
import { MemoryFileSystem, ROOT, demoFolder } from "./testing";

let fs: MemoryFileSystem;
let project: EditorProject;
const onDisk = (path: string) => fs.files.get(joinPath(ROOT, path));

beforeEach(async () => {
  Input.reset();
  fs = demoFolder();
  fs.files.set(joinPath(ROOT, "scripts/Spinner.ts"), `import { GameBehavior, behavior } from "tranquility";\n@behavior("game.Spinner")\nexport class Spinner extends GameBehavior {}\n`);
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  await replaceScripts(project.scripts);
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
  askBeforeDeletingAssets.value = false;
});

afterEach(async () => {
  askBeforeDeletingAssets.value = true;
  assetClipboard.value = null;
  await replaceScripts(new Map());
});

describe("names", () => {
  it("splits extensions, counting .scene.json and .prefab.json as one", () => {
    expect(splitExtension("bird.png")).toEqual(["bird", ".png"]);
    expect(splitExtension("pipe-pair.prefab.json")).toEqual(["pipe-pair", ".prefab.json"]);
    expect(splitExtension("README")).toEqual(["README", ""]);
  });

  it("finds a free name, and refuses bad ones", () => {
    expect(freePath(project, "images", "bird.png")).toBe("images/bird.png");
    expect(freePath(project, "images", "background.png")).toBe("images/background 2.png");
    expect(freePath(project, "images", "background.png", true)).toBe("images/background copy.png");
    expect(freePath(project, "", "images")).toBe("images 2");
    expect(whyNotValidName("a/b")).toMatch(/can't contain/);
    expect(whyNotValidName(" ")).toMatch(/empty/);
    expect(whyNotValidName("ok.png")).toBeNull();
  });
});

describe("renaming and moving", () => {
  it("renames an image on disk and updates the prefab that uses it; the open scene shows it", async () => {
    expect(await renameAsset("images/background.png", "sky.png")).toBe(true);
    expect(onDisk("images/background.png")).toBeUndefined();
    expect(onDisk("images/sky.png")).toBeInstanceOf(Uint8Array);
    expect(project.files).toContain("images/sky.png");
    expect(onDisk("prefabs/background.prefab.json")).toContain('"asset:images/sky.png"');
    expect(status.value?.text).toBe("Renamed images/background.png to images/sky.png. Updated references in prefabs/background.prefab.json.");
    const sprite = openScene.value!.sync.nodeFor("bg-a")!.getBehavior(SpriteRenderer) ?? openScene.value!.sync.nodeFor("bg-a")!.children[0]?.getBehavior(SpriteRenderer);
    expect(sprite?.sprite).toBe("images/sky.png");
  });

  it("moves a prefab into a new folder; the open scene's instances follow as one undo step", async () => {
    const folder = (await newFolder("prefabs"))!;
    expect(folder).toBe("prefabs/New Folder");
    expect(project.folders).toContain("prefabs/New Folder");
    expect(await moveAssetsTo(["prefabs/background.prefab.json"], folder)).toBe(true);
    const { doc, stack } = openScene.value!;
    expect(doc.node("bg-a").prefab).toBe("prefabs/New Folder/background.prefab.json");
    expect(openScene.value!.sync.nodeFor("bg-a")).not.toBeNull();
    expect(stack.undoLabel).toBe("Update references to background.prefab.json");
    expect(status.value?.text).toMatch(/Updated references in scenes\/main\.scene\.json \(unsaved\)/);
  });

  it("moves a folder with everything in it, and updates paths inside it and project.json", async () => {
    expect(await moveAssets([["prefabs", "things/prefabs"]])).toBe(true);
    expect(project.files).toContain("things/prefabs/music.prefab.json");
    expect(project.folders).not.toContain("prefabs");
    expect(JSON.parse(onDisk("project.json") as string).autoload).toEqual(["things/prefabs/music.prefab.json"]);
    expect(openScene.value!.doc.node("bg-a").prefab).toBe("things/prefabs/background.prefab.json");
  });

  it("refuses moves that can't work", async () => {
    expect(await moveAssets([["scenes", "other/scenes"]])).toBe(false);
    expect(status.value?.text).toMatch(/holds the scene open now/);
    expect(await moveAssets([["images", "images/inner"]])).toBe(false);
    expect(status.value?.text).toMatch(/into itself/);
    expect(await moveAssetsTo(["scripts/Spinner.ts"], "images")).toBe(false);
    expect(status.value?.text).toMatch(/scripts live under scripts\//);
    expect(await renameAsset("images/PipeUp.png", "PipeDown.png")).toBe(false);
    expect(status.value?.text).toMatch(/already exists/);
    expect(whyNotMoveTarget(["images/"], "images/sub")).toMatch(/inside itself/);
    expect(whyNotMoveTarget(["images/bird.png"], "images")).toMatch(/already/);
  });
});

describe("copying", () => {
  it("duplicates files and folders beside themselves", async () => {
    expect(await duplicateAssets(["images/background.png"])).toEqual(["images/background copy.png"]);
    expect(onDisk("images/background copy.png")).toBeInstanceOf(Uint8Array);
    expect(await duplicateAssets(["music/"])).toEqual(["music copy/"]);
    expect(project.files).toContain("music copy/town.mp3");
    expect(await duplicateAssets(["scripts/Spinner.ts"])).toEqual(["scripts/Spinner copy.ts"]);
    expect(project.scripts.has("scripts/Spinner copy.ts")).toBe(true);
  });

  it("pastes copies, or moves after a cut", async () => {
    assetClipboard.value = { entries: ["images/ground.jpg"], cut: false };
    expect(await pasteAssets("music")).toEqual(["music/ground.jpg"]);
    expect(project.files).toContain("images/ground.jpg");
    assetClipboard.value = { entries: ["images/ground.jpg"], cut: true };
    expect(await pasteAssets("music")).toEqual([]); // the name's taken there now
    expect(status.value?.text).toMatch(/already exists/);
    expect(await copyAssets(["images/"], "images")).toEqual([]);
    expect(status.value?.text).toMatch(/into itself/);
    assetClipboard.value = { entries: ["images/PipeUp.png"], cut: true };
    expect(await pasteAssets("")).toEqual(["PipeUp.png"]);
    expect(project.files).toContain("PipeUp.png");
    expect(assetClipboard.value).toBeNull();
  });
});

describe("deleting several", () => {
  it("deletes files and folders together, cleaning references to everything inside", async () => {
    expect(await deleteAssets(["music/", "images/PipeUp.png"])).toBe(true);
    expect(project.files.some((f) => f.startsWith("music/"))).toBe(false);
    expect(project.folders).not.toContain("music");
    expect(onDisk("images/PipeUp.png")).toBeUndefined();
    expect(onDisk("prefabs/music.prefab.json")).not.toContain("town.mp3");
    expect(status.value?.text).toMatch(/^Deleted 2 items\. Removed references from /);
  });
});
