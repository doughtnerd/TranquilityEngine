import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { SpriteRenderer } from "../engine/render/components";
import { addAssetEntries, idBase, parentForAdd, prefabInstanceEntry, spriteNodeEntry, uniqueId, whyNotAddable } from "./assetNodes";
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

describe("the nodes adding an asset makes (ADR 0026, 0149, 0241)", () => {
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

  /** The low-level add under a selection (the + button goes through `addAssets`, addAssets.test.ts). */
  const addAssetToScene = (scene: NonNullable<typeof openScene.value>, path: string, selected: string | null, position?: readonly [number, number, number]) =>
    addAssetEntries(scene, path, { parent: parentForAdd(scene.doc, selected), position })[0].id;

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
    const scene = openScene.value!, { doc } = scene;
    expect(addAssetEntries(scene, "prefabs/pipe-pair.prefab.json", { position: [3, 4, 0], placeInstances: true })[0]).toMatchObject({
      prefab: "prefabs/pipe-pair.prefab.json",
      overrides: [{ component: "engine.Transform", field: "position", value: [3, 4, 0] }],
    });
    expect(addAssetEntries(scene, "prefabs/pipe-pair.prefab.json", { position: [3, 4, 0] })[0].overrides).toBeUndefined();
    expect(whyNotAddable(doc, "scenes/main.scene.json")).toMatch(/inside itself/); // the open scene
    expect(() => addAssetEntries(scene, "scenes/main.scene.json")).toThrow(/inside itself/);
    expect(whyNotAddable(doc, "prefabs/pipe-pair.prefab.json")).toBeNull();
  });

  it("adds a particle effect through the Particles plugin's addToScene policy", () => {
    expect(addAssetEntries(openScene.value!, "fx/smoke-puff.particles.json", { position: [1, 2, 0] })[0]).toEqual({
      id: "smoke-puff-particles", // idBase drops only the last extension
      name: "Smoke-puff",
      components: [
        { type: "engine.Transform", data: { position: [1, 2, 0] } },
        { type: "engine.ParticleSystem", data: { effect: "asset:fx/smoke-puff.particles.json" } },
      ],
    });
  });
});
