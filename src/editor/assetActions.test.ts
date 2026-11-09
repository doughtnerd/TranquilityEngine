import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import {
  assetCommandLabel,
  assetKeyCommand,
  assetPluginItems,
  assetShortcut,
  panelTarget,
  runAsset,
  whyNotAsset,
  type AssetCommandId,
  type AssetTarget,
} from "./assetActions";
import { entryFolder, entryKind, entryName, entryPath, fileEntries, folderEntry, isFolderEntry, isSliceEntry, sliceEntry, splitSliceEntry } from "./assetEntry";
import { assetClipboard } from "./assetOps";
import { arrowSelection, assetQuery, folderPath, renamingAsset, resetAssetBrowser, select, selectedAssets } from "./assetSelection";
import { OrbitCamera } from "./OrbitCamera";
import { askBeforeDeletingAssets } from "./preferences";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { replaceScripts } from "./scriptLoader";
import { assetActions } from "./sdk/contributions";
import { currentProject, openScene, openScenes, playState, sceneCamera, status, type OpenScene } from "./state";
import { MemoryFileSystem, ROOT, demoFolder, useCoreAssetKinds } from "./testing";

useCoreAssetKinds();

let fs: MemoryFileSystem;
let project: EditorProject;
const onDisk = (path: string) => fs.files.has(joinPath(ROOT, path));
const on = (...entries: string[]): AssetTarget => ({ project, entries });
const ALL: AssetCommandId[] = ["open", "rename", "duplicate", "copy", "cut", "paste", "delete"];

beforeEach(async () => {
  Input.reset();
  fs = demoFolder();
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  await replaceScripts(project.scripts);
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
  askBeforeDeletingAssets.value = false;
  resetAssetBrowser();
});

afterEach(async () => {
  askBeforeDeletingAssets.value = true;
  assetClipboard.value = null;
  openScenes.value = [];
  playState.value = "edit";
  await replaceScripts(new Map());
});

describe("asset entries", () => {
  it("encode files, folders and slices in one place", () => {
    expect(folderEntry("images")).toBe("images/");
    expect(isFolderEntry("images/")).toBe(true);
    expect(entryPath("images/")).toBe("images");
    expect(entryPath("images/a.png")).toBe("images/a.png");
    const slice = sliceEntry("images/sheet.png", "walk_0");
    expect(isSliceEntry(slice)).toBe(true);
    expect(isSliceEntry("images/sheet.png")).toBe(false);
    expect(splitSliceEntry(slice)).toEqual({ image: "images/sheet.png", slice: "walk_0" });
    expect([entryName(slice), entryName("images/"), entryName("images/a.png")]).toEqual(["walk_0", "images", "a.png"]);
    expect([entryFolder(slice), entryFolder("images/"), entryFolder("a/b/c.png")]).toEqual(["images", "", "a/b"]);
    expect([entryKind("images/"), entryKind(slice), entryKind("images/a.png")]).toEqual(["folder", "sprite", "image"]);
    expect(fileEntries(["images/", slice, "a.png"])).toEqual(["images/", "a.png"]);
  });
});

describe("keys and menus agree", () => {
  /** The key press a menu's shortcut label describes. */
  const press = (shortcut: string) => {
    const ctrl = shortcut.startsWith("Ctrl+");
    const key = ctrl ? shortcut.slice(5).toLowerCase() : shortcut === "Del" ? "Delete" : shortcut;
    return { key, ctrlKey: ctrl, metaKey: false, altKey: false, shiftKey: false };
  };

  it("each command's shortcut label is the key that runs it", () => {
    for (const id of ALL) expect(assetKeyCommand(press(assetShortcut(id))), id).toBe(id);
    expect(assetKeyCommand({ key: "Backspace", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe("delete");
    expect(assetKeyCommand({ key: "c", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBe("copy"); // Cmd on macOS
    expect(assetKeyCommand({ key: "Delete", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })).toBeNull();
    expect(assetKeyCommand({ key: "a", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBeNull();
  });

  it("a key refuses exactly when its menu item is disabled, and says why", async () => {
    openScenes.value = [openScene.value!, { path: "prefabs/background.prefab.json" } as OpenScene];
    const target = on("prefabs/background.prefab.json");
    for (const id of ["delete", "cut", "rename"] as const) {
      const reason = whyNotAsset(id, target);
      expect(reason, id).toMatch(/another scene tab/);
      status.value = { kind: "info", text: "" };
      expect(await runAsset(id, target), id).toBe(false);
      expect(status.value?.text, id).toContain(reason!);
    }
    expect(assetClipboard.value).toBeNull();
    expect(renamingAsset.value).toBeNull();
  });
});

describe("deleting", () => {
  it("is unavailable for a scene open in another tab, which the operation would refuse (not only the active tab)", async () => {
    openScenes.value = [openScene.value!, { path: "prefabs/background.prefab.json" } as OpenScene];
    expect(whyNotAsset("delete", on("prefabs/background.prefab.json"))).toMatch(/another scene tab/);
    expect(whyNotAsset("delete", on("prefabs/"))).toMatch(/another tab/);
    expect(whyNotAsset("delete", on("images/background.png", "prefabs/background.prefab.json"))).toMatch(/^background\.prefab\.json: /);
    expect(await runAsset("delete", on("prefabs/background.prefab.json"))).toBe(false);
    expect(onDisk("prefabs/background.prefab.json")).toBe(true);
    expect(status.value?.text).toBe("Can't delete background.prefab.json: it's open in another scene tab; close that tab first.");
  });

  it("refuses the active scene, nothing selected, slices alone, play mode and read-only projects", () => {
    expect(whyNotAsset("delete", on("scenes/main.scene.json"))).toMatch(/open now/);
    expect(whyNotAsset("delete", on())).toBe("select something first");
    expect(whyNotAsset("delete", on(sliceEntry("images/background.png", "a")))).toMatch(/slices aren't files/);
    playState.value = "playing";
    expect(whyNotAsset("delete", on("images/background.png"))).toBe("stop playing first");
    playState.value = "edit";
    expect(whyNotAsset("delete", { project: { ...project, canSave: false } as EditorProject, entries: ["images/background.png"] })).toMatch(/read-only/);
  });

  it("deletes the selection's files, skipping slices", async () => {
    expect(await runAsset("delete", on("music/foo.mp3", sliceEntry("images/background.png", "a")))).toBe(true);
    expect(onDisk("music/foo.mp3")).toBe(false);
  });
});

describe("copying, cutting and pasting", () => {
  it("copies, then pastes into a selected folder and selects the copies", async () => {
    expect(whyNotAsset("paste", on())).toBe("nothing copied");
    expect(await runAsset("copy", on("images/flappyBird.png"))).toBe(true);
    expect(assetClipboard.value).toEqual({ entries: ["images/flappyBird.png"], cut: false });
    expect(whyNotAsset("paste", on("music/"))).toBeNull();
    expect(await runAsset("paste", on("music/"))).toBe(true);
    expect(onDisk("music/flappyBird.png")).toBe(true);
    expect(selectedAssets.value).toEqual(["music/flappyBird.png"]);
  });

  it("refuses pasting a cut into the folder it came from, and a folder into itself", async () => {
    folderPath.value = "images";
    await runAsset("cut", on("images/flappyBird.png"));
    expect(whyNotAsset("paste", on())).toBe("they're in that folder already");
    expect(await runAsset("paste", on())).toBe(false);
    expect(status.value?.text).toBe("Can't paste here: they're in that folder already.");
    assetClipboard.value = { entries: ["images/"], cut: false };
    folderPath.value = "";
    expect(whyNotAsset("paste", on("images/"))).toMatch(/inside itself/);
  });

  it("moves after a cut, and the clipboard empties", async () => {
    await runAsset("cut", on("music/foo.mp3"));
    expect(await runAsset("paste", on("images/"))).toBe(true);
    expect(onDisk("images/foo.mp3")).toBe(true);
    expect(onDisk("music/foo.mp3")).toBe(false);
    expect(selectedAssets.value).toEqual(["images/foo.mp3"]);
    expect(assetClipboard.value).toBeNull();
  });

  it("duplicates beside themselves and selects the copies; read-only projects can't", async () => {
    expect(await runAsset("duplicate", on("music/town.mp3", "prefabs/"))).toBe(true);
    expect(selectedAssets.value).toEqual(["music/town copy.mp3", "prefabs copy/"]);
    expect(whyNotAsset("duplicate", { project: { ...project, canSave: false } as EditorProject, entries: ["music/town.mp3"] })).toMatch(/read-only/);
    expect(whyNotAsset("paste", { project: { ...project, canSave: false } as EditorProject, entries: [] })).toMatch(/read-only/);
  });
});

describe("renaming and opening", () => {
  it("renames one at a time, in place", async () => {
    expect(whyNotAsset("rename", on("music/foo.mp3", "music/town.mp3"))).toBe("rename one at a time");
    expect(await runAsset("rename", on("music/foo.mp3"))).toBe(true);
    expect(renamingAsset.value).toBe("music/foo.mp3");
    expect(selectedAssets.value).toEqual(["music/foo.mp3"]);
  });

  it("opens one folder or file whose kind opens; slices open their image in the Sprite Editor", async () => {
    expect(whyNotAsset("open", on("music/", "images/"))).toBe("open one at a time");
    expect(whyNotAsset("open", on("music/foo.mp3"))).toBe("this kind of file doesn't open");
    expect(await runAsset("open", on("music/"))).toBe(true);
    expect(folderPath.value).toBe("music");
    const slices = on(sliceEntry("images/background.png", "a"), sliceEntry("images/background.png", "b"));
    expect(whyNotAsset("open", slices)).toBeNull();
    expect(assetCommandLabel("open", slices)).toBe("Sprite Editor…");
    expect(assetCommandLabel("open", on("images/background.png"))).toBe("Sprite Editor…");
    expect(assetCommandLabel("open", on("scenes/main.scene.json"))).toBe("Open");
  });
});

describe("plugins' asset actions (ADR 0146)", () => {
  it("are offered for the selected files or slices, unavailable read-only when they write, and select what they make", async () => {
    const seen: unknown[] = [];
    const undo = assetActions.register({
      id: "test.action",
      label: "Make Thing",
      writes: true,
      appliesTo: (_p, targets) => targets.every((t) => t.slice !== undefined),
      run: async (_p, targets) => {
        seen.push(targets);
        return ["music/foo.mp3"];
      },
    });
    try {
      expect(assetPluginItems(on("music/town.mp3"))).toEqual([]);
      const items = assetPluginItems(on(sliceEntry("images/background.png", "a")));
      expect(items.map((i) => [i.label, i.whyNot])).toEqual([["Make Thing", null]]);
      items[0].run();
      await new Promise((r) => setTimeout(r, 0));
      expect(seen).toEqual([[{ path: "images/background.png", slice: "a" }]]);
      expect(selectedAssets.value).toEqual(["music/foo.mp3"]);
      const readOnly = { project: { ...project, canSave: false } as EditorProject, entries: [sliceEntry("images/background.png", "a")] };
      expect(assetPluginItems(readOnly)[0].whyNot).toMatch(/read-only/);
    } finally {
      undo();
    }
  });
});

describe("the panel's selection", () => {
  it("is what's selected among what the panel lists (the menu bar acts on it)", () => {
    folderPath.value = "music";
    select(["music/foo.mp3", "images/flappyBird.png"]);
    expect(panelTarget()?.entries).toEqual(["music/foo.mp3"]);
    assetQuery.value = "flappy";
    expect(panelTarget()?.entries).toEqual(["images/flappyBird.png"]);
  });

  it("Shift+arrows extend from the anchor; plain arrows select one", () => {
    const items = ["a/", "x.png", "y.png", "z.png"];
    expect(arrowSelection(items, "x.png", "x.png", "ArrowRight", 1, false)).toEqual({ selected: ["y.png"], focus: "y.png", anchor: "y.png" });
    expect(arrowSelection(items, "y.png", "x.png", "ArrowRight", 1, true)).toEqual({ selected: ["x.png", "y.png", "z.png"], focus: "z.png", anchor: "x.png" });
    expect(arrowSelection(items, "y.png", "y.png", "ArrowUp", 2, true)).toEqual({ selected: ["a/", "x.png", "y.png"], focus: "a/", anchor: "y.png" });
    expect(arrowSelection(items, "x.png", null, "Enter", 1, false)).toBeNull();
  });
});
