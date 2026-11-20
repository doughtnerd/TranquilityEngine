// The Hierarchy drop (ADR 0258) on the sample's main scene: `bird` (with its child `bird-sprite`) and `ceiling` are
// plain nodes, and `pipe` a pipe-pair instance added here (its inner nodes `pipe/top`, `pipe/bottom` and `pipe/gate`:
// inner keys are the instance id and the node's id).
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { AddNode } from "./document";
import { dropRowName, hierarchyDrop, NO_MOVE_INSIDE } from "./hierarchyDrop";
import { insertNodes } from "./nodeInsertion";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets } from "./projects";
import { openScene, sceneCamera } from "./state";
import { sampleProject, useCoreAssetKinds } from "./testing";

useCoreAssetKinds();

beforeEach(async () => {
  Input.reset();
  const project = sampleProject();
  useProjectAssets(project);
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
  openScene.value!.stack.execute(new AddNode({ id: "pipe", prefab: "prefabs/pipe-pair.prefab.json" }));
});

const scene = () => openScene.value!;

describe("scene rows", () => {
  it("over the middle of a row: that node becomes the parent", () => {
    expect(hierarchyDrop(scene().doc, "bird", 0.5)).toEqual({ mode: "into", row: "bird", insert: { kind: "into", key: "bird" }, move: { parent: "bird" } });
  });

  it("near a row's top or bottom edge: a sibling before or after it", () => {
    const { doc } = scene();
    const at = doc.roots().indexOf("ceiling");
    expect(hierarchyDrop(doc, "ceiling", 0.1)).toEqual({ mode: "before", row: "ceiling", insert: { kind: "into", key: null, index: at }, move: { parent: null, index: at } });
    expect(hierarchyDrop(doc, "ceiling", 0.9)).toMatchObject({ mode: "after", move: { parent: null, index: at + 1 } });
    expect(hierarchyDrop(doc, "bird-sprite", 0.9)).toMatchObject({ mode: "after", insert: { kind: "into", key: "bird", index: 1 } });
  });

  it("empty space or the scene header: the scene's top level; a gone row: nothing", () => {
    const { doc } = scene();
    expect(hierarchyDrop(doc, null, 0)).toEqual({ mode: "root", row: null, insert: { kind: "into", key: null }, move: { parent: null } });
    expect(hierarchyDrop(doc, "gone", 0.5)).toBeNull();
  });

  it("inserts at the chosen place, as one undoable step", () => {
    const drop = hierarchyDrop(scene().doc, "ceiling", 0.1)!;
    const made = insertNodes(scene(), { kind: "assets", paths: ["music/foo.mp3"] }, drop.insert);
    const id = made.ok ? made.keys[0]! : "";
    const roots = scene().doc.roots();
    expect(roots[roots.indexOf("ceiling") - 1]).toBe(id);
    scene().stack.undo();
    expect(scene().doc.has(id)).toBe(false);
  });
});

describe("rows inside a prefab instance (ADR 0246's open question)", () => {
  it("the middle of an inner row inserts into it as an addNodes override; moving scene nodes there is refused", () => {
    const drop = hierarchyDrop(scene().doc, "pipe/top", 0.5)!;
    expect(drop).toEqual({ mode: "into", row: "pipe/top", insert: { kind: "into", key: "pipe/top" }, move: { reason: NO_MOVE_INSIDE } });
    const made = insertNodes(scene(), { kind: "assets", paths: ["images/flappyBird.png"] }, drop.insert);
    expect(made.ok && made.keys[0]).toBe("pipe/flappy-bird");
    expect(scene().doc.node("pipe").overrides?.at(-1)).toMatchObject({ target: ["top"], addNodes: [{ id: "flappy-bird" }] });
    expect(scene().sync.nodeFor(["pipe", "flappy-bird"])!.parent!.name).toBe("Top");
  });

  it("an inner row's edges mark its parent: an override has no order", () => {
    // A top-level inner row's parent is the instance itself, which takes scene nodes as children.
    expect(hierarchyDrop(scene().doc, "pipe/top", 0.1)).toEqual({ mode: "into", row: "pipe", insert: { kind: "into", key: "pipe" }, move: { parent: "pipe" } });
    // A node added inside Top: its edges mean into Top, as an override again.
    const made = insertNodes(scene(), { kind: "new", node: "empty" }, { kind: "into", key: "pipe/top" });
    const key = made.ok ? made.keys[0]! : "";
    expect(hierarchyDrop(scene().doc, key, 0.9)).toEqual({ mode: "into", row: "pipe/top", insert: { kind: "into", key: "pipe/top" }, move: { reason: NO_MOVE_INSIDE } });
    expect(hierarchyDrop(scene().doc, "pipe/nope", 0.5)).toBeNull();
  });

  it("names the row a drop marks", () => {
    expect(dropRowName(scene().doc, "pipe/top")).toBe("Top");
    expect(dropRowName(scene().doc, "bird")).toBe("Bird");
    expect(dropRowName(scene().doc, null)).toBe("the scene");
  });
});
