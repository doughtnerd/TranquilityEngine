import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { deleteSelected } from "./deleteSelection";
import { AddNode } from "./document";
import { deleteNodes } from "./hierarchyEdit";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets } from "./projects";
import { ancestorKeys, combineSelection, hierarchyEntries, rangeBetween, selectModeFor, topmostKeys, withDescendants } from "./selectionModel";
import { openScene, sceneCamera, select, selectedKeys, selectedNodes, selection } from "./state";
import { boxBetween, colliderBounds, colliderHits, idsInBox, keysNear } from "./viewportSelection";
import { sampleProject } from "./testing";

afterEach(() => select([]));

describe("the selection", () => {
  it("keeps selection order; the last key is the active node", () => {
    select(["a", "b", "a", "c"]);
    expect(selectedKeys.value).toEqual(["a", "b", "c"]);
    expect(selection.value).toBe("c");
    select(["a", "b", "c"], "a");
    expect(selectedKeys.value).toEqual(["b", "c", "a"]);
  });

  it("setting the active node selects just that node", () => {
    select(["a", "b"]);
    selection.value = "z";
    expect(selectedKeys.value).toEqual(["z"]);
    selection.value = null;
    expect(selectedKeys.value).toEqual([]);
  });

  it("doesn't notify when nothing changed", () => {
    select(["a", "b"]);
    const before = selectedKeys.value;
    select(["a", "b"]);
    expect(selectedKeys.value).toBe(before);
  });
});

describe("combining a gesture with the selection", () => {
  it("replaces, adds (Shift) or toggles (Ctrl/Cmd)", () => {
    expect(combineSelection(["a", "b"], ["c"], "replace")).toEqual(["c"]);
    expect(combineSelection(["a", "b"], ["b", "c"], "add")).toEqual(["a", "b", "c"]);
    expect(combineSelection(["a", "b"], ["b", "c"], "toggle")).toEqual(["a", "c"]);
  });

  it("reads the mode from modifier keys, Ctrl/Cmd over Shift", () => {
    expect(selectModeFor({ shiftKey: false, ctrlKey: false, metaKey: false })).toBe("replace");
    expect(selectModeFor({ shiftKey: true, ctrlKey: false, metaKey: false })).toBe("add");
    expect(selectModeFor({ shiftKey: true, ctrlKey: true, metaKey: false })).toBe("toggle");
    expect(selectModeFor({ shiftKey: false, ctrlKey: false, metaKey: true })).toBe("toggle");
  });

  it("takes Shift ranges in row order, either direction", () => {
    const order = ["a", "b", "c", "d"];
    expect(rangeBetween(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(order, null, "c")).toEqual(["c"]);
  });
});

/** A stand-in World node: only identity matters to the box and radius tests. */
const fake = (name: string) => ({ name }) as unknown as GameObject;

describe("box and radius hits", () => {
  const sprite = fake("sprite"), pivot = fake("pivot"), inner = fake("inner"), far = fake("far");
  const bounds = [
    { node: pivot, rect: { left: 50, top: 50, right: 50, bottom: 50 } }, // a node that draws nothing: its origin
    { node: sprite, rect: { left: 40, top: 40, right: 80, bottom: 70 } },
    { node: inner, rect: { left: 90, top: 40, right: 140, bottom: 60 } }, // inside a prefab instance
    { node: far, rect: { left: 300, top: 300, right: 320, bottom: 320 } },
  ];
  const ids: Record<string, string> = { sprite: "sprite", pivot: "pivot", inner: "pipe", far: "far" };
  const paths: Record<string, string[]> = { sprite: ["sprite"], pivot: ["pivot"], inner: ["pipe", "top"], far: ["far"] };

  it("selects nodes lying entirely inside the box", () => {
    const idOf = (n: GameObject) => ids[n.name];
    expect(idsInBox(bounds, boxBetween({ x: 45, y: 45 }, { x: 85, y: 75 }), idOf)).toEqual(["pivot"]); // the sprite pokes out
    expect(idsInBox(bounds, boxBetween({ x: 150, y: 80 }, { x: 30, y: 30 }), idOf)).toEqual(["pivot", "sprite", "pipe"]); // dragged up-left
  });

  it("treats a prefab instance as everything drawn inside it", () => {
    const idOf = (n: GameObject) => (n === far ? "pipe" : ids[n.name]);
    expect(idsInBox(bounds, { left: 0, top: 0, right: 200, bottom: 200 }, idOf)).toEqual(["pivot", "sprite"]); // the pipe's far part is outside
  });

  it("lists nodes near a point, however deep, with the instance of an inner node", () => {
    const pathOf = (n: GameObject) => paths[n.name];
    expect(keysNear(bounds, 85, 50, 10, pathOf)).toEqual(["sprite", "pipe", "pipe/top"]);
    expect(keysNear(bounds, 200, 200, 10, pathOf)).toEqual([]);
  });
});

describe("collider areas", () => {
  const ground = fake("ground"), bird = fake("bird");
  const square = (cx: number, cy: number, half: number, z = 0): [number, number, number][] => [
    [cx - half, cy - half, z],
    [cx + half, cy - half, z],
    [cx + half, cy + half, z],
    [cx - half, cy + half, z],
  ];
  const shapes = [
    { node: ground, points: square(0, 0, 10) },
    { node: bird, points: square(1, 1, 0.7, 2) },
  ];

  it("counts a click anywhere inside a collider, smallest collider first, on each collider's plane", () => {
    const flat = (x: number, y: number) => (z: number) => [x, y, z];
    expect(colliderHits(shapes, flat(1.2, 0.8))).toEqual([bird, ground]);
    expect(colliderHits(shapes, flat(5, 5))).toEqual([ground]);
    expect(colliderHits(shapes, flat(50, 0))).toEqual([]);
    expect(colliderHits(shapes, (z) => (z === 2 ? null : [1, 1, z]))).toEqual([ground]); // the ray misses the bird's plane
  });

  it("measures each collider's rectangle on the canvas, leaving out ones behind the camera", () => {
    const project = (p: readonly number[]): [number, number] | null => (p[2] === 2 ? null : [p[0] * 10 + 100, 100 - p[1] * 10]);
    expect(colliderBounds(shapes, project)).toEqual([{ node: ground, rect: { left: 0, top: 0, right: 200, bottom: 200 } }]);
  });
});

describe("with the demo scene open", () => {
  beforeEach(async () => {
    Input.reset();
    const project = sampleProject();
    useProjectAssets(project);
    const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    openSceneFile(engine, project.mainScene!);
    // A pipe pair: a prefab instance with nodes inside it.
    openScene.value!.stack.execute(new AddNode({ id: "pipe", prefab: "prefabs/pipe-pair.prefab.json" }));
  });

  it("lists hierarchy rows in order, prefab inner nodes included", () => {
    const rows = hierarchyEntries(openScene.value!.doc);
    const keys = rows.map((r) => r.key);
    expect(keys.slice(0, 3)).toEqual(["camera", "bg-a", "bg-b"]);
    expect(keys.slice(-4)).toEqual(["pipe", "pipe/top", "pipe/bottom", "pipe/gate"]);
    expect(rows.find((r) => r.key === "pipe/top")).toMatchObject({ depth: 1, inner: true });
    expect(keys.indexOf("bird-sprite")).toBe(keys.indexOf("bird") + 1);
  });

  it("trims a selection to its topmost nodes", () => {
    const { doc } = openScene.value!;
    expect(ancestorKeys(doc, "pipe/top")).toEqual(["pipe"]);
    expect(ancestorKeys(doc, "bird-sprite")).toEqual(["bird"]);
    expect(topmostKeys(doc, ["bird-sprite", "ceiling", "bird", "pipe/top"])).toEqual(["ceiling", "bird", "pipe/top"]);
    expect(topmostKeys(doc, ["pipe/top", "pipe"])).toEqual(["pipe"]);
  });

  it("adds children to the Alt+click list", () => {
    expect(withDescendants(openScene.value!.doc, ["pipe", "bird", "bg-a"]).map((e) => e.key)).toEqual(["bg-a", "bird", "bird-sprite", "pipe", "pipe/top", "pipe/bottom", "pipe/gate"]);
  });

  it("finds every selected node that still exists, active last", () => {
    select(["bird", "nope", "pipe/top"]);
    expect(selectedNodes().map((s) => s.key)).toEqual(["bird", "pipe/top"]);
  });

  it("deletes several selected nodes as one undo step, children with their parents", async () => {
    const scene = openScene.value!;
    select(["ceiling", "ground-collider"]);
    expect(await deleteSelected()).toBe(true);
    expect(scene.doc.has("ceiling") || scene.doc.has("ground-collider")).toBe(false);
    expect(scene.stack.undoLabel).toBe("Delete 2 nodes");
    expect(selectedKeys.value).toEqual([]);
    scene.stack.undo();
    expect(scene.doc.has("ceiling") && scene.doc.has("ground-collider")).toBe(true);

    expect(deleteNodes(scene, ["bird", "ceiling"]).map((r) => `${r.path[0]}.${r.field}`)).toContain("game.bird");
    scene.stack.undo();
    expect(scene.doc.fieldValue("game", "game.GameManager", "bird")).toEqual({ $node: "bird" });
  });

  it("refuses to delete when a selected node is inside a prefab instance", async () => {
    select(["ceiling", "pipe/top"]);
    expect(await deleteSelected()).toBe(false);
    expect(openScene.value!.doc.has("ceiling")).toBe(true);
  });
});
