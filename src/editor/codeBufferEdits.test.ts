// Unsaved Code panel text (ADR 0308) through the editor's own operations: the discard guard, moves and deletes
// of files a buffer names or is, and the delete prompt. Without Monaco: the buffers module is the interface.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { deleteAssets } from "./assetDelete";
import { moveAssets, renameAsset, whyNotMovable } from "./assetOps";
import { bufferText, closeAllScripts, dirtyScripts, editBuffer, openScript, openScripts, saveBuffer } from "./code/codeBuffers";
import { confirmDiscard } from "./dialogs";
import { OrbitCamera } from "./OrbitCamera";
import { askBeforeDeletingAssets } from "./preferences";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { replaceScripts } from "./scriptLoader";
import { saveCodeFile } from "./session";
import { currentProject, sceneCamera, status } from "./state";
import { MemoryFileSystem, ROOT, demoFolder, useCoreAssetKinds } from "./testing";
import type { ConfirmOptions } from "./ui/ConfirmDialog";

const asked: ConfirmOptions[] = [];
vi.mock("./ui/ConfirmDialog", () => ({
  confirmInEditor: (options: ConfirmOptions) => {
    asked.push(options);
    return Promise.resolve({ ok: true, option: false });
  },
}));

useCoreAssetKinds();

let fs: MemoryFileSystem;
let project: EditorProject;
const onDisk = (path: string) => fs.files.get(joinPath(ROOT, path)) as string;
const LEVEL = `{\n  "sky": "asset:images/background.png",\n  "speed": 4\n}\n`;

beforeEach(async () => {
  Input.reset();
  asked.length = 0;
  fs = demoFolder();
  fs.files.set(joinPath(ROOT, "data/level.json"), LEVEL);
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  closeAllScripts();
  await replaceScripts(project.scripts);
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
  askBeforeDeletingAssets.value = false;
});

afterEach(async () => {
  askBeforeDeletingAssets.value = true;
  closeAllScripts();
  vi.unstubAllGlobals();
  await replaceScripts(new Map());
});

describe("the discard guard", () => {
  it("asks before discarding unsaved Code panel text, naming the file", async () => {
    expect(await confirmDiscard()).toBe(true);
    openScript("data/level.json");
    editBuffer("data/level.json", `{ "speed": 5 }`);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    expect(await confirmDiscard()).toBe(false);
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to data/level.json?");
  });
});

describe("a move", () => {
  it("rewrites a file the Code panel holds unsaved text for in the buffer too, so the next save keeps the new reference", async () => {
    openScript("data/level.json");
    editBuffer("data/level.json", LEVEL.replace('"speed": 4', '"speed": 7'));
    expect(await renameAsset("images/background.png", "sky.png")).toBe(true);
    expect(JSON.parse(onDisk("data/level.json"))).toEqual({ sky: "asset:images/sky.png", speed: 4 });
    expect(JSON.parse(bufferText("data/level.json")!)).toEqual({ sky: "asset:images/sky.png", speed: 7 });
    expect(dirtyScripts.value.has("data/level.json")).toBe(true);
    expect(status.value?.text).toContain("data/level.json");
    await saveBuffer("data/level.json", saveCodeFile);
    expect(JSON.parse(onDisk("data/level.json"))).toEqual({ sky: "asset:images/sky.png", speed: 7 });
    expect(dirtyScripts.value.size).toBe(0);
  });

  it("takes a file with unsaved text along, still unsaved", async () => {
    openScript("data/level.json");
    editBuffer("data/level.json", `{ "speed": 8 }\n`);
    expect(whyNotMovable(project, ["data/level.json"])).toBeNull();
    expect(await moveAssets([["data/level.json", "levels.json"]])).toBe(true);
    expect(openScripts.value).toEqual(["levels.json"]);
    expect(bufferText("levels.json")).toBe(`{ "speed": 8 }\n`);
    expect(onDisk("levels.json")).toBe(LEVEL);
  });

  it("is refused while unsaved text that names the file isn't valid JSON, before anything changes", async () => {
    openScript("data/level.json");
    editBuffer("data/level.json", `{ "sky": "asset:images/background.png", `);
    expect(await renameAsset("images/background.png", "sky.png")).toBe(false);
    expect(status.value?.text).toMatch(/Can't move background\.png: data\/level\.json has unsaved changes in the Code panel that aren't valid JSON/);
    expect(project.files).toContain("images/background.png");
  });
});

describe("a delete", () => {
  it("asks, saying the file's unsaved Code panel text is lost, even with asking turned off", async () => {
    openScript("data/level.json");
    editBuffer("data/level.json", `{ "speed": 5 }`);
    expect(await deleteAssets(["data/level.json"])).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].message).toMatch(/data\/level\.json has unsaved changes in the Code panel, which are lost/);
    expect(openScripts.value).toEqual([]);
    expect(dirtyScripts.value.size).toBe(0);
  });

  it("doesn't mention unsaved text when there is none", async () => {
    askBeforeDeletingAssets.value = true;
    openScript("data/level.json");
    expect(await deleteAssets(["data/level.json"])).toBe(true);
    expect(asked[0].message).not.toMatch(/unsaved/);
  });
});
