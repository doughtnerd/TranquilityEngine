import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { SpriteRenderer } from "../engine/render/components";
import { addAssets } from "./addAssets";
import { idBase, nodeForAsset, parentForAdd, prefabInstanceEntry, spriteNodeEntry, uniqueId, whyNotAddable } from "./assetNodes";
import { OrbitCamera } from "./OrbitCamera";
import { particlesEditorPlugin } from "../plugins/particles/editor";
import { activatePlugins, deactivatePlugin } from "./sdk/plugins";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets } from "./projects";
import { openScene, sceneCamera } from "./state";
import { sampleProject, useCoreAssetKinds } from "./testing";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

const demo = sampleProject();

const PLUGINS = [particlesEditorPlugin];
beforeAll(() => activatePlugins(PLUGINS));
afterAll(() => PLUGINS.forEach((p) => deactivatePlugin(p.manifest.name)));

describe("the nodes adding an asset makes (ADR 0026, 0149)", () => {
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

  /** Add under a selection, as the Assets panel's + does (`addAssets`); the new node's id, or the refusal. */
  const addAssetToScene = async (path: string, selected: string | null, position: readonly [number, number, number] = [0, 0, 0]) => {
    const { ids, message } = await addAssets([path], { kind: "selection", selected, position });
    if (!ids[0]) throw new Error(message.text);
    return ids[0];
  };

  it("adds a prefab instance as one undoable step, twice with distinct ids", async () => {
    const scene = openScene.value!;
    const first = await addAssetToScene("prefabs/pipe-pair.prefab.json", null);
    const second = await addAssetToScene("prefabs/pipe-pair.prefab.json", null);
    expect([first, second]).toEqual(["pipe-pair", "pipe-pair-2"]);
    expect(scene.doc.node("pipe-pair").prefab).toBe("prefabs/pipe-pair.prefab.json");
    expect(scene.sync.nodeFor("pipe-pair")?.name).toBe("PipePair"); // instantiated in the Editor World
    scene.stack.undo();
    scene.stack.undo();
    expect(scene.doc.has("pipe-pair")).toBe(false);
  });

  it("adds a sprite for an image at the given position, under the selected node", async () => {
    const scene = openScene.value!;
    const id = await addAssetToScene("images/flappyBird.png", "bird", [3, 1, 0]);
    expect(scene.doc.parentOf(id)).toBe("bird");
    const node = scene.sync.nodeFor(id)!;
    expect(node.getBehavior(SpriteRenderer)!.sprite).toBe("images/flappyBird.png");
    expect(node.transform!.position.toArray()).toEqual([3, 1, 0]);
  });

  it("refuses assets with no kind of scene node", async () => {
    await expect(addAssetToScene("project.json", null)).rejects.toThrow(/no kind of scene node fits/);
  });

  it("turns audio into an AudioSource node", async () => {
    const scene = openScene.value!;
    const id = await addAssetToScene("music/town.mp3", null, [1, 2, 0]);
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

  it("adds a particle effect through the Particles plugin's addToScene policy", () => {
    const { doc } = openScene.value!;
    expect(nodeForAsset(doc, "fx/smoke-puff.particles.json", { position: [1, 2, 0] })).toEqual({
      id: "smoke-puff-particles", // idBase drops only the last extension
      name: "Smoke-puff",
      components: [
        { type: "engine.Transform", data: { position: [1, 2, 0] } },
        { type: "engine.ParticleSystem", data: { effect: "asset:fx/smoke-puff.particles.json" } },
      ],
    });
  });
});
