import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { SceneInstance } from "../engine/scene/SceneLoader";
import { AddNode } from "./document";
import { insertNodes, whyNotInsert } from "./nodeInsertion";
import { dropDescription } from "./assetDrag";
import { hierarchyDrop } from "./hierarchyDrop";
import { OrbitCamera } from "./OrbitCamera";
import { instanceInnerNodes } from "./nodeKey";
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

describe("the drag's label", () => {
  it("describes what releasing will do, inside a prefab instance too (ADR 0258)", () => {
    const { doc } = openScene.value!;
    const drag = (drop: ReturnType<typeof hierarchyDrop>, problem: string | null = null) => ({ paths: ["images/bird.png"], x: 0, y: 0, target: drop && { kind: "hierarchy" as const, drop }, problem });
    expect(dropDescription(drag(hierarchyDrop(doc, "bird", 0.5)), doc)).toBe("Add bird.png as a child of Bird");
    expect(dropDescription(drag(hierarchyDrop(doc, "ceiling", 0.1)), doc)).toBe("Add bird.png above Ceiling");
    openScene.value!.stack.execute(new AddNode({ id: "pipe", prefab: "prefabs/pipe-pair.prefab.json" }));
    expect(dropDescription(drag(hierarchyDrop(doc, "pipe/top", 0.5)), doc)).toBe("Add bird.png as a child of Top (an override of its prefab instance)");
    expect(dropDescription(drag(null, "no kind of scene node fits this file"), doc)).toBe("bird.png: no kind of scene node fits this file");
  });
});

describe("dropping a scene into another scene (ADR 0016)", () => {
  it("adds a scene node holding the scene's top-level nodes", () => {
    openSceneFile(engine, "prefabs/pipe-pair.prefab.json");
    const scene = openScene.value!;
    const source = { kind: "assets", paths: ["scenes/main.scene.json"], position: [0, 20, 0], placeInstances: true } as const;
    expect(whyNotInsert(scene, source, { kind: "into", key: null })).toBeNull();
    const made = insertNodes(scene, source, { kind: "into", key: null });
    const id = made.ok ? made.keys[0]! : "";

    const node = scene.sync.nodeFor(id)!;
    expect(node.isSceneNode).toBe(true);
    expect(node.getBehavior(SceneInstance)!.source).toBe("scenes/main.scene.json");
    expect(node.transform!.position.toArray()).toEqual([0, 20, 0]); // placed where it was dropped
    expect(node.children.map((c) => c.name)).toContain("Bird");
    expect(scene.sync.nodeFor([id, "bird"])).not.toBeNull();
    expect(instanceInnerNodes(openScene.value!.doc, id).map((n) => n.path)).toContainEqual([id, "bird"]);
  });

  it("refuses a prefab that would contain the scene being edited", () => {
    openSceneFile(engine, "prefabs/pipe-pair.prefab.json");
    expect(whyNotInsert(openScene.value!, { kind: "assets", paths: ["prefabs/pipe-pair.prefab.json"] }, { kind: "into", key: null })).toMatch(/inside itself/);
  });
});
