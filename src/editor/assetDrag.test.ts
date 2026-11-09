import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { SceneInstance } from "../engine/scene/SceneLoader";
import { addAssets } from "./addAssets";
import { whyNotAddable } from "./assetNodes";
import { dropDescription, hierarchyDrop } from "./assetDrag";
import { OrbitCamera } from "./OrbitCamera";
import { innerNodes } from "./prefabs";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets } from "./projects";
import { openScene, sceneCamera } from "./state";
import { sampleProject, useCoreAssetKinds } from "./testing";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

let engine: Engine;

beforeEach(async () => {
  Input.reset();
  const project = sampleProject();
  useProjectAssets(project);
  engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
});

describe("hierarchy drop targets", () => {
  it("over the middle of a row: that node becomes the parent", () => {
    expect(hierarchyDrop(openScene.value!.doc, "bird", 0.5)).toEqual({ kind: "hierarchy", mode: "into", row: "bird", parent: "bird" });
  });

  it("near a row's top or bottom edge: a sibling before or after it", () => {
    const { doc } = openScene.value!;
    const at = doc.roots().indexOf("ceiling");
    expect(hierarchyDrop(doc, "ceiling", 0.1)).toEqual({ kind: "hierarchy", mode: "before", row: "ceiling", parent: null, index: at });
    expect(hierarchyDrop(doc, "ceiling", 0.9)).toEqual({ kind: "hierarchy", mode: "after", row: "ceiling", parent: null, index: at + 1 });
    expect(hierarchyDrop(doc, "bird-sprite", 0.9)).toMatchObject({ mode: "after", parent: "bird", index: 1 });
  });

  it("empty space or the scene header: the scene's top level; rows inside prefabs: invalid", () => {
    const { doc } = openScene.value!;
    expect(hierarchyDrop(doc, null, 0)).toEqual({ kind: "hierarchy", mode: "root", row: null, parent: null });
    expect(hierarchyDrop(doc, "bg-a/tile", 0.5)).toBeNull();
    expect(hierarchyDrop(doc, "gone", 0.5)).toBeNull();
  });

  it("drops at the chosen place, as one undoable step", async () => {
    const scene = openScene.value!;
    const target = hierarchyDrop(scene.doc, "ceiling", 0.1)!;
    if (target.kind !== "hierarchy") throw new Error("expected a hierarchy target");
    const id = (await addAssets(["music/foo.mp3"], { kind: "slot", parent: target.parent, index: target.index })).ids[0]!;
    const roots = scene.doc.roots();
    expect(roots[roots.indexOf("ceiling") - 1]).toBe(id);
    expect(scene.doc.node(id).components!.map((c) => c.type)).toEqual(["engine.Transform", "engine.AudioSource"]);
    scene.stack.undo();
    expect(scene.doc.has(id)).toBe(false);
  });

  it("describes what releasing will do", () => {
    const { doc } = openScene.value!;
    const drag = (target: ReturnType<typeof hierarchyDrop>, problem: string | null = null) => ({ paths: ["images/bird.png"], x: 0, y: 0, target, problem });
    expect(dropDescription(drag(hierarchyDrop(doc, "bird", 0.5)), doc)).toBe("Add bird.png as a child of Bird");
    expect(dropDescription(drag(hierarchyDrop(doc, "ceiling", 0.1)), doc)).toBe("Add bird.png above Ceiling");
    expect(dropDescription(drag(null, "no kind of scene node fits this file"), doc)).toBe("bird.png: no kind of scene node fits this file");
  });
});

describe("dropping a scene into another scene (ADR 0016)", () => {
  it("adds a scene node holding the scene's top-level nodes", async () => {
    openSceneFile(engine, "prefabs/pipe-pair.prefab.json");
    const scene = openScene.value!;
    expect(whyNotAddable(scene.doc, "scenes/main.scene.json")).toBeNull();
    const id = (await addAssets(["scenes/main.scene.json"], { kind: "point", position: [0, 20, 0] })).ids[0]!;

    const node = scene.sync.nodeFor(id)!;
    expect(node.isSceneNode).toBe(true);
    expect(node.getBehavior(SceneInstance)!.source).toBe("scenes/main.scene.json");
    expect(node.transform!.position.toArray()).toEqual([0, 20, 0]); // placed where it was dropped
    expect(node.children.map((c) => c.name)).toContain("Bird");
    expect(scene.sync.nodeFor([id, "bird"])).not.toBeNull();
    expect(innerNodes("scenes/main.scene.json", [id]).map((n) => n.path)).toContainEqual([id, "bird"]);
  });

  it("refuses a prefab that would contain the scene being edited", () => {
    openSceneFile(engine, "prefabs/pipe-pair.prefab.json");
    expect(whyNotAddable(openScene.value!.doc, "prefabs/pipe-pair.prefab.json")).toMatch(/inside itself/);
  });
});
