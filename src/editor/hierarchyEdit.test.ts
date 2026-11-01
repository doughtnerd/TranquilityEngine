import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { GameManager } from "../demo/flappy/behaviors/GameManager";
import { deleteNode, moveNode, referencesInto, whyNotDeletable, whyNotMovable } from "./hierarchyEdit";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { bundledDemoProject, editorSettings, useProjectAssets } from "./projects";
import { openScene, sceneCamera } from "./state";

beforeEach(async () => {
  Input.reset();
  const project = bundledDemoProject();
  useProjectAssets(project);
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
});

const world = (id: string) => openScene.value!.sync.nodeFor(id)!.transform!.worldPosition.toArray().map((v) => Math.round(v * 1000) / 1000);

describe("moving nodes in the hierarchy", () => {
  it("reorders among siblings without touching the transform", () => {
    const { doc, stack } = openScene.value!;
    expect(moveNode(openScene.value!, "ceiling", null, 0)).toBe(true);
    expect(doc.roots()[0]).toBe("ceiling");
    expect(doc.fieldValue("ceiling", "engine.Transform", "position")).toEqual([0, 11, 0]);
    expect(stack.undoLabel).toBe("Reorder Ceiling");
    stack.undo();
    expect(doc.roots()[0]).toBe("camera");
  });

  it("moving further down among the same siblings lands where it was dropped", () => {
    const { doc } = openScene.value!;
    const roots = doc.roots();
    const target = roots.indexOf("bird") + 1; // "below Bird", counted with Ceiling still in place
    moveNode(openScene.value!, "ceiling", null, target);
    const after = doc.roots();
    expect(after[after.indexOf("bird") + 1]).toBe("ceiling");
  });

  it("does nothing when the node would stay where it is", () => {
    const { doc, stack } = openScene.value!;
    const at = doc.roots().indexOf("ceiling");
    expect(moveNode(openScene.value!, "ceiling", null, at)).toBe(false);
    expect(moveNode(openScene.value!, "ceiling", null, at + 1)).toBe(false);
    expect(stack.canUndo).toBe(false);
  });

  it("reparenting keeps the node where it is in the world", () => {
    const scene = openScene.value!;
    const before = world("ceiling");
    moveNode(scene, "ceiling", "bird");
    expect(scene.doc.parentOf("ceiling")).toBe("bird");
    expect(scene.doc.fieldValue("ceiling", "engine.Transform", "position")).toEqual([4, 10, 0]); // relative to Bird at (-4, 1)
    expect(world("ceiling")).toEqual(before);
    expect(scene.stack.undoLabel).toBe("Move Ceiling");
    scene.stack.undo(); // one step: parent and position together
    expect(scene.doc.parentOf("ceiling")).toBeNull();
    expect(scene.doc.fieldValue("ceiling", "engine.Transform", "position")).toEqual([0, 11, 0]);
  });

  it("unparenting keeps the node where it is too", () => {
    const scene = openScene.value!;
    const before = world("bird-sprite");
    moveNode(scene, "bird-sprite", null);
    expect(scene.doc.parentOf("bird-sprite")).toBeNull();
    expect(world("bird-sprite")).toEqual(before);
  });

  it("moves prefab instances like any node, recording the new position as an override", () => {
    const scene = openScene.value!;
    const before = world("bg-b");
    moveNode(scene, "bg-b", "bird");
    expect(scene.doc.overrideValue("bg-b", [], "engine.Transform", "position")).toEqual([36, 2, 0]);
    expect(world("bg-b")).toEqual(before);
  });

  it("refuses moves into the node itself, its children, or a prefab's insides", () => {
    const { doc } = openScene.value!;
    expect(whyNotMovable(doc, "bird", "bird")).toMatch(/inside itself/);
    expect(whyNotMovable(doc, "bird", "bird-sprite")).toMatch(/inside itself/);
    expect(whyNotMovable(doc, "bg-a/tile", null)).toMatch(/inside a prefab/);
    expect(whyNotMovable(doc, "ceiling", "bg-a/tile")).toMatch(/inside a prefab/);
    expect(() => moveNode(openScene.value!, "bird", "bird-sprite")).toThrow(/inside itself/);
  });
});

describe("deleting nodes", () => {
  it("deletes a node and its children as one undoable step", () => {
    const scene = openScene.value!;
    expect(deleteNode(scene, "ceiling")).toEqual([]);
    expect(scene.doc.has("ceiling")).toBe(false);
    expect(scene.sync.nodeFor("ceiling")).toBeNull();
    scene.stack.undo();
    expect(scene.doc.has("ceiling")).toBe(true);
    expect(scene.sync.nodeFor("ceiling")).not.toBeNull();
  });

  it("clears references to the deleted nodes, and undo restores them", () => {
    const scene = openScene.value!;
    const refs = referencesInto(scene.doc, "bird");
    expect(refs.map((r) => `${r.path[0]}.${r.field}`)).toContain("game.bird");
    expect(refs.every((r) => r.path[0] !== "bird")).toBe(true); // Bird's own reference to its sprite doesn't count

    deleteNode(scene, "bird");
    expect(scene.doc.has("bird")).toBe(false);
    expect(scene.doc.has("bird-sprite")).toBe(false);
    expect(scene.doc.fieldValue("game", "game.GameManager", "bird")).toBeNull();
    expect(scene.stack.undoLabel).toBe("Delete Bird");

    scene.stack.undo();
    expect(scene.doc.fieldValue("game", "game.GameManager", "bird")).toEqual({ $node: "bird" });
    // The live GameManager points at the restored Bird again.
    expect(scene.sync.nodeFor("game")!.getBehavior(GameManager)!.bird).toBe(scene.sync.nodeFor("bird"));
  });

  it("refuses nodes inside prefab instances", () => {
    expect(whyNotDeletable(openScene.value!.doc, "bg-a/tile")).toMatch(/inside a prefab/);
  });
});
