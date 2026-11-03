import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, getComponentClass } from "../engine";
import { listComponents } from "../engine/editor";
import { assetUsers, deleteAsset, whyNotDeletableAsset } from "./assetDelete";
import { OrbitCamera } from "./OrbitCamera";
import { askBeforeDeletingAssets } from "./preferences";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { replaceScripts } from "./scriptLoader";
import { currentProject, openScene, sceneCamera, status } from "./state";
import { MemoryFileSystem, ROOT, demoFolder } from "./testing";

let fs: MemoryFileSystem;
let project: EditorProject;
const SPAWNER = `import { GameBehavior, behavior, field, AssetRef } from "myco";
@behavior("game.Spawner2")
export class Spawner2 extends GameBehavior {
  @field(AssetRef) prefab = "prefabs/pipe-pair.prefab.json";
}
`;

beforeEach(async () => {
  Input.reset();
  fs = demoFolder();
  fs.files.set(joinPath(ROOT, "scripts/Spawner2.ts"), SPAWNER);
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  await replaceScripts(project.scripts);
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
});

afterEach(async () => {
  askBeforeDeletingAssets.value = true;
  await replaceScripts(new Map());
});

describe("what uses an asset", () => {
  it("finds prefabs and scenes, project settings and scripts that refer to it", () => {
    expect(assetUsers(project, "images/background.png")).toEqual(["prefabs/background.prefab.json"]);
    expect(assetUsers(project, "prefabs/music.prefab.json")).toEqual(["project.json"]);
    expect(assetUsers(project, "prefabs/pipe-pair.prefab.json")).toEqual(["scripts/Spawner2.ts"]);
    expect(assetUsers(project, "prefabs/background.prefab.json")).toEqual(["scenes/main.scene.json"]);
    expect(assetUsers(project, "music/town.mp3")).toEqual(["prefabs/music.prefab.json"]);
  });

  it("includes the open scene's unsaved edits", () => {
    expect(assetUsers(project, "images/gone.png", { path: "scenes/main.scene.json", text: '{"x":"asset:images/gone.png"}' })).toEqual(["scenes/main.scene.json (unsaved edits)"]);
  });
});

describe("deleting", () => {
  it("refuses project.json, the open scene and read-only projects", () => {
    expect(whyNotDeletableAsset(project, "project.json", null)).toMatch(/defines the project/);
    expect(whyNotDeletableAsset(project, "scenes/main.scene.json", "scenes/main.scene.json")).toMatch(/open now/);
    expect(whyNotDeletableAsset({ ...project, canSave: false } as EditorProject, "images/background.png", null)).toMatch(/read-only/);
  });

  it("removes the file from disk and the project, and takes it out of the prefabs that used it", async () => {
    askBeforeDeletingAssets.value = false; // no dialog in a headless test
    expect(await deleteAsset("images/background.png")).toBe(true);
    expect(fs.files.has(joinPath(ROOT, "images/background.png"))).toBe(false);
    expect(project.files).not.toContain("images/background.png");
    const prefab = fs.files.get(joinPath(ROOT, "prefabs/background.prefab.json")) as string;
    expect(prefab).not.toContain("background.png");
    expect(JSON.parse(prefab).nodes[0].components[1].data).toEqual({ size: [32.05, 25], sortingLayer: "Background" });
    expect(status.value?.text).toBe("Deleted images/background.png. Removed references from prefabs/background.prefab.json.");
    expect(status.value?.action?.label).toBe("Ask before deleting");
    // The open scene's instances show the cleaned prefab.
    const sprite = listComponents(openScene.value!.sync.nodeFor("bg-a")!).find((c) => c.type === "engine.SpriteRenderer")!;
    expect(sprite.fields.find((f) => f.name === "sprite")!.value).toBe("");
  });

  it("removes a deleted prefab's instances from the open scene as one undoable step, and from the project's autoloads", async () => {
    askBeforeDeletingAssets.value = false;
    const { doc, stack } = openScene.value!;
    await deleteAsset("prefabs/background.prefab.json");
    expect(doc.has("bg-a") || doc.has("bg-b")).toBe(false);
    expect(stack.dirty).toBe(true); // saving keeps it
    expect(stack.undoLabel).toBe("Remove references to background.prefab.json");
    expect(status.value?.text).toBe("Deleted prefabs/background.prefab.json. Removed references from scenes/main.scene.json (unsaved).");

    // Undo brings the instances back; with their prefab gone they show as empty nodes rather than failing.
    stack.undo();
    expect(doc.has("bg-a")).toBe(true);
    expect(openScene.value!.sync.nodeFor("bg-a")).not.toBeNull();

    await deleteAsset("prefabs/music.prefab.json");
    expect(JSON.parse(fs.files.get(joinPath(ROOT, "project.json")) as string).autoload).toEqual([]);
  });

  it("lists scripts that still mention it; they aren't edited", async () => {
    askBeforeDeletingAssets.value = false;
    await deleteAsset("prefabs/pipe-pair.prefab.json");
    expect(status.value?.text).toBe("Deleted prefabs/pipe-pair.prefab.json. Still referred to by scripts/Spawner2.ts.");
    expect(project.scripts.get("scripts/Spawner2.ts")).toContain("prefabs/pipe-pair.prefab.json");
  });

  it("reloads scripts after deleting one, so its types go", async () => {
    askBeforeDeletingAssets.value = false;
    expect(getComponentClass("game.Spawner2")).toBeDefined();
    await deleteAsset("scripts/Spawner2.ts");
    expect(project.scripts.has("scripts/Spawner2.ts")).toBe(false);
    expect(getComponentClass("game.Spawner2")).toBeUndefined();
  });

  it("won't delete the scene that's open", async () => {
    expect(await deleteAsset(openScene.value!.path)).toBe(false);
    expect(status.value?.text).toMatch(/Can't delete main\.scene\.json: it's the scene open now/);
  });
});
