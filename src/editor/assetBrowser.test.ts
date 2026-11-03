import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, SpriteRenderer } from "../engine";
import {
  addAssetToScene,
  assetKind,
  buildFolderTree,
  findFolder,
  idBase,
  nodeForAsset,
  parentForAdd,
  prefabInstanceEntry,
  searchFiles,
  spriteNodeEntry,
  uniqueId,
  whyNotAddable,
} from "./assetBrowser";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets } from "./projects";
import { openScene, sceneCamera } from "./state";
import { sampleProject } from "./testing";

const demo = sampleProject();

describe("asset browser: folders and search", () => {
  it("builds a sorted folder tree from project paths", () => {
    const tree = buildFolderTree(["images/b.png", "project.json", "images/a.png", "scenes/main.scene.json", "images/ui/icon.png"]);
    expect(tree.files).toEqual(["project.json"]);
    expect(tree.folders.map((f) => f.name)).toEqual(["images", "scenes"]);
    const images = findFolder(tree, "images")!;
    expect(images.files).toEqual(["images/a.png", "images/b.png"]);
    expect(findFolder(tree, "images/ui")!.files).toEqual(["images/ui/icon.png"]);
    expect(findFolder(tree, "missing")).toBeNull();
    expect(findFolder(tree, "")).toBe(tree);
  });

  it("has the demo's folders", () => {
    const tree = buildFolderTree(demo.files);
    expect(tree.folders.map((f) => f.name)).toEqual(expect.arrayContaining(["images", "music", "prefabs", "scenes"]));
  });

  it("searches file names across folders, every word must match", () => {
    expect(searchFiles(demo.files, "pipe").sort()).toEqual(["images/PipeDown.png", "images/PipeUp.png", "prefabs/pipe-pair.prefab.json"]);
    expect(searchFiles(demo.files, "pipe prefab")).toEqual(["prefabs/pipe-pair.prefab.json"]);
    expect(searchFiles(demo.files, "PIPEUP")).toEqual(["images/PipeUp.png"]);
    expect(searchFiles(demo.files, "  ")).toEqual([]);
  });

  it("knows asset kinds", () => {
    expect(assetKind("scenes/main.scene.json")).toBe("scene");
    expect(assetKind("prefabs/pipe-pair.prefab.json")).toBe("prefab");
    expect(assetKind("images/bird.PNG")).toBe("image");
    expect(assetKind("music/town.mp3")).toBe("audio");
    expect(assetKind("project.json")).toBe("json");
  });
});

describe("asset browser: adding to the scene (ADR 0026)", () => {
  beforeEach(async () => {
    Input.reset();
    useProjectAssets(demo);
    const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(demo) });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    openSceneFile(engine, demo.mainScene!);
  });

  it("derives unique ids from file names", () => {
    const { doc } = openScene.value!;
    expect(idBase("prefabs/pipe-pair.prefab.json")).toBe("pipe-pair");
    expect(idBase("images/flappyBird.png")).toBe("flappy-bird");
    expect(idBase("images/My Sprite!.png")).toBe("my-sprite");
    expect(uniqueId(doc, "fresh")).toBe("fresh");
    expect(uniqueId(doc, "bird")).toBe("bird-2"); // "bird" is taken in the demo scene
  });

  it("builds a prefab instance entry and a sprite node entry", () => {
    const { doc } = openScene.value!;
    expect(prefabInstanceEntry(doc, "prefabs/pipe-pair.prefab.json")).toEqual({ id: "pipe-pair", prefab: "prefabs/pipe-pair.prefab.json" });
    expect(spriteNodeEntry(doc, "images/flappyBird.png", [1, 2, 0])).toEqual({
      id: "flappy-bird",
      name: "FlappyBird",
      components: [
        { type: "engine.Transform", data: { position: [1, 2, 0] } },
        { type: "engine.SpriteRenderer", data: { sprite: "asset:images/flappyBird.png" } }, // no size: pixels per unit decides
      ],
    });
  });

  it("parents under the selection, beside a selected prefab instance, or at the top level", () => {
    const { doc } = openScene.value!;
    expect(parentForAdd(doc, null)).toBeNull();
    expect(parentForAdd(doc, "bird")).toBe("bird");
    expect(parentForAdd(doc, "bg-a")).toBeNull(); // a top-level prefab instance: add beside it
    expect(parentForAdd(doc, "gone")).toBeNull();
    // A node inside a prefab instance (a path key): add beside the instance.
    expect(parentForAdd(doc, "bg-a/inner")).toBeNull();
  });

  it("adds a prefab instance as one undoable step, twice with distinct ids", () => {
    const scene = openScene.value!;
    const first = addAssetToScene(scene, "prefabs/pipe-pair.prefab.json", null);
    const second = addAssetToScene(scene, "prefabs/pipe-pair.prefab.json", null);
    expect([first, second]).toEqual(["pipe-pair", "pipe-pair-2"]);
    expect(scene.doc.node("pipe-pair").prefab).toBe("prefabs/pipe-pair.prefab.json");
    expect(scene.sync.nodeFor("pipe-pair")?.name).toBe("PipePair"); // instantiated in the Editor World
    scene.stack.undo();
    scene.stack.undo();
    expect(scene.doc.has("pipe-pair")).toBe(false);
  });

  it("adds a sprite for an image at the given position, under the selected node", () => {
    const scene = openScene.value!;
    const id = addAssetToScene(scene, "images/flappyBird.png", "bird", [3, 1, 0]);
    expect(scene.doc.parentOf(id)).toBe("bird");
    const node = scene.sync.nodeFor(id)!;
    expect(node.getBehavior(SpriteRenderer)!.sprite).toBe("images/flappyBird.png");
    expect(node.transform!.position.toArray()).toEqual([3, 1, 0]);
  });

  it("refuses assets with no kind of scene node", () => {
    expect(() => addAssetToScene(openScene.value!, "project.json", null)).toThrow(/no kind of scene node fits/);
  });

  it("turns audio into an AudioSource node", () => {
    const scene = openScene.value!;
    const id = addAssetToScene(scene, "music/town.mp3", null, [1, 2, 0]);
    expect(scene.doc.node(id)).toMatchObject({
      name: "Town",
      components: [
        { type: "engine.Transform", data: { position: [1, 2, 0] } },
        { type: "engine.AudioSource", data: { clip: "asset:music/town.mp3" } },
      ],
    });
  });

  it("instances scenes and prefabs, placed when asked, and refuses self-nesting", () => {
    const { doc } = openScene.value!;
    expect(nodeForAsset(doc, "scenes/main.scene.json")).toMatchObject({ prefab: "scenes/main.scene.json" });
    expect(nodeForAsset(doc, "prefabs/pipe-pair.prefab.json", { position: [3, 4, 0], placeInstances: true })).toMatchObject({
      prefab: "prefabs/pipe-pair.prefab.json",
      overrides: [{ component: "engine.Transform", field: "position", value: [3, 4, 0] }],
    });
    expect(nodeForAsset(doc, "prefabs/pipe-pair.prefab.json", { position: [3, 4, 0] })!.overrides).toBeUndefined();
    expect(whyNotAddable(doc, "scenes/main.scene.json")).toMatch(/inside itself/); // the open scene
    expect(whyNotAddable(doc, "prefabs/pipe-pair.prefab.json")).toBeNull();
  });
});
