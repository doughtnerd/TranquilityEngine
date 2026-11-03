import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { SceneDocument, type SceneFile } from "./document";
import { filterHierarchy, parseHierarchyQuery } from "./hierarchyFilter";
import { moveNodes } from "./hierarchyEdit";
import { createNode, newNodeEntry, uniqueName } from "./nodeCreate";
import { copyNodes, cutNodes, duplicateNodes, entriesForPaste, parseClipboardText, clipboardText, pasteNodes, pasteTarget, subtreeRoots, whyNotCopyable, whyNotPastable } from "./nodeClipboard";
import { draggedKeys, nodeDropProblem } from "./nodeDrag";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets } from "./projects";
import { openScene, sceneCamera, type OpenScene } from "./state";
import { sampleProject } from "./testing";

let scene: OpenScene;

beforeEach(async () => {
  Input.reset();
  const project = sampleProject();
  useProjectAssets(project);
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
  scene = openScene.value!;
});

const name = (id: string) => scene.doc.node(id).name ?? id;

describe("creating nodes", () => {
  it("adds each kind as one undo step with a unique id and name", () => {
    const { doc, stack } = scene;
    const id = createNode(scene, "camera");
    expect(id).toBe("camera-2"); // the sample has a "camera" already
    expect(name(id)).toBe("Camera (1)"); // and a top-level "Camera"
    expect(doc.fieldValue(id, "engine.Camera", "projection")).toBe("orthographic");
    expect(stack.undoLabel).toBe("Create Camera (1)");
    expect(scene.sync.nodeFor(id)).not.toBeNull();
    stack.undo();
    expect(doc.has(id)).toBe(false);
  });

  it("creates children under a node, at an index, and sprites, text and empty nodes", () => {
    const { doc } = scene;
    const sprite = createNode(scene, "sprite", { parent: "bird" });
    expect(doc.parentOf(sprite)).toBe("bird");
    expect(name(sprite)).toBe("Sprite (1)"); // Bird already has a child called Sprite
    expect(doc.components(sprite).map((c) => c.type)).toEqual(["engine.Transform", "engine.SpriteRenderer"]);
    const text = createNode(scene, "text", { parent: null, index: 0 });
    expect(doc.roots()[0]).toBe(text);
    expect(doc.fieldValue(text, "engine.Text", "text")).toBe("New Text");
    const empty = createNode(scene, "empty", { position: [1, 2, 0] });
    expect(doc.fieldValue(empty, "engine.Transform", "position")).toEqual([1, 2, 0]);
    expect(() => createNode(scene, "empty", { parent: "pipe/top" })).toThrow(/inside a prefab/);
  });

  it("numbers names among siblings only", () => {
    const doc = new SceneDocument({ format: "myco.scene@1", nodes: [{ id: "a", name: "Node" }, { id: "b", name: "Node (1)" }, { id: "c", name: "Node", parent: "a" }] });
    expect(uniqueName(doc, null, "Node")).toBe("Node (2)");
    expect(uniqueName(doc, "b", "Node")).toBe("Node");
    expect(uniqueName(doc, null, "Node (1)")).toBe("Node (2)");
    expect(newNodeEntry(doc, "empty", "a").name).toBe("Node (1)");
  });
});

describe("copy, paste, duplicate and cut", () => {
  it("copies whole subtrees (topmost selected nodes, in hierarchy order)", () => {
    const clip = copyNodes(scene.doc, ["bird-sprite", "ceiling", "bird"]);
    expect(clip.subtrees.map((s) => s.map((e) => e.id))).toEqual([["ceiling"], ["bird", "bird-sprite"]]);
    expect(whyNotCopyable(scene.doc, ["pipe/top"])).toMatch(/inside a prefab/);
    expect(whyNotCopyable(scene.doc, [])).toMatch(/select/);
  });

  it("pastes with new ids, re-pointing references inside the copy", () => {
    const { doc, stack } = scene;
    const clip = copyNodes(doc, ["bird"]);
    const [copy] = pasteNodes(scene, clip, pasteTarget(doc, "bird"));
    expect(copy).toBe("bird-2");
    expect(name(copy)).toBe("Bird (1)");
    expect(doc.roots().indexOf(copy)).toBe(doc.roots().indexOf("bird") + 1);
    const [child] = doc.children(copy);
    expect(child).toBe("bird-sprite-2");
    expect(doc.fieldValue(copy, "game.Bird", "visual")).toEqual({ $node: "bird-sprite-2" });
    expect(doc.fieldValue("bird", "game.Bird", "visual")).toEqual({ $node: "bird-sprite" }); // the original's untouched
    expect(stack.undoLabel).toBe("Paste Bird (1)");
    stack.undo();
    expect(doc.has(copy)).toBe(false);
    expect(doc.has(child)).toBe(false);
  });

  it("keeps references to other nodes within the same scene, and clears them in another", () => {
    const { doc } = scene;
    const ref = doc.references().find((r) => r.path.length === 1 && r.path[0] !== "bird" && doc.subtree(r.to).length > 0 && !doc.subtree(r.path[0]).includes(r.to))!;
    const clip = copyNodes(doc, [ref.path[0]]);
    const same = entriesForPaste(doc, clip, null)[0][0];
    expect(same.components!.find((c) => c.type === ref.type)!.data![ref.field]).toEqual({ $node: ref.to });
    const other = new SceneDocument({ format: "myco.scene@1", nodes: [{ id: ref.to, name: "Lookalike" }] }, "scenes/other.scene.json");
    const elsewhere = entriesForPaste(other, clip, null)[0][0];
    expect(elsewhere.components!.find((c) => c.type === ref.type)!.data![ref.field]).toBeNull();
  });

  it("copies prefab instances with their overrides", () => {
    const { doc } = scene;
    const clip = copyNodes(doc, ["bg-b"]);
    const [copy] = pasteNodes(scene, clip, { parent: null });
    expect(doc.node(copy).prefab).toBe("prefabs/background.prefab.json");
    expect(doc.overrides(copy)).toEqual(doc.overrides("bg-b"));
    expect(scene.sync.nodeFor(copy)).not.toBeNull();
  });

  it("pastes into a node as its last child", () => {
    const { doc } = scene;
    const [copy] = pasteNodes(scene, copyNodes(doc, ["ceiling"]), pasteTarget(doc, "bird", true));
    expect(doc.parentOf(copy)).toBe("bird");
    expect(doc.children("bird").at(-1)).toBe(copy);
    expect(whyNotPastable(doc, copyNodes(doc, ["ceiling"]), "pipe/top")).toMatch(/inside a prefab/);
    expect(whyNotPastable(doc, null, null)).toMatch(/nothing/);
  });

  it("pasting into another scene works from the clipboard (paste survives switching scenes)", () => {
    const clip = copyNodes(scene.doc, ["bird"]);
    const other = new SceneDocument({ format: "myco.scene@1", nodes: [] }, "scenes/empty.scene.json");
    const [[root, child]] = entriesForPaste(other, clip, null);
    expect(root.id).toBe("bird");
    expect(child.parent).toBe("bird");
  });

  it("duplicates several nodes, each after itself, as one step", () => {
    const { doc, stack } = scene;
    const made = duplicateNodes(scene, ["ceiling", "ground-collider"]);
    expect(made).toEqual(["ground-collider-2", "ceiling-2"]);
    const roots = doc.roots();
    expect(roots[roots.indexOf("ceiling") + 1]).toBe("ceiling-2");
    expect(roots[roots.indexOf("ground-collider") + 1]).toBe("ground-collider-2");
    expect(stack.undoLabel).toBe("Duplicate 2 nodes");
    stack.undo();
    expect(doc.has("ceiling-2") || doc.has("ground-collider-2")).toBe(false);
  });

  it("cut removes the nodes in one step and pastes them back", () => {
    const { doc, stack } = scene;
    const clip = cutNodes(scene, ["bird"]);
    expect(doc.has("bird")).toBe(false);
    expect(doc.has("bird-sprite")).toBe(false);
    expect(stack.undoLabel).toBe("Cut Bird");
    const [again] = pasteNodes(scene, clip, { parent: null });
    expect(again).toBe("bird"); // the id is free again
    expect(doc.fieldValue("bird", "game.Bird", "visual")).toEqual({ $node: "bird-sprite" });
  });

  it("round-trips through system clipboard text", () => {
    const clip = copyNodes(scene.doc, ["bird"]);
    expect(parseClipboardText(clipboardText(clip))).toEqual(clip);
    expect(parseClipboardText("hello")).toBeNull();
    expect(parseClipboardText('{"format":"other"}')).toBeNull();
  });

  it("refuses to paste a prefab into itself", () => {
    const prefab: SceneFile = { format: "myco.scene@1", nodes: [{ id: "root", name: "Bg" }] };
    const doc = new SceneDocument(prefab, "prefabs/background.prefab.json");
    expect(whyNotPastable(doc, copyNodes(scene.doc, ["bg-a"]), null)).toMatch(/inside itself/);
  });
});

describe("moving several nodes", () => {
  it("moves them in order to a new parent as one step", () => {
    const { doc, stack } = scene;
    expect(moveNodes(scene, ["ceiling", "ground-collider"], "bird")).toBe(true);
    expect(doc.children("bird").slice(-2)).toEqual(["ceiling", "ground-collider"]);
    expect(stack.undoLabel).toBe("Move 2 nodes");
    stack.undo();
    expect(doc.parentOf("ceiling")).toBeNull();
    expect(doc.parentOf("ground-collider")).toBeNull();
  });

  it("places them before a sibling, keeping their order", () => {
    const { doc } = scene;
    moveNodes(scene, ["ceiling", "bird"], null, 0);
    expect(doc.roots().slice(0, 3)).toEqual(["ceiling", "bird", "camera"]);
  });

  it("drags the selection's topmost nodes when the row is selected", () => {
    const { doc } = scene;
    expect(draggedKeys(doc, "bird", ["bird-sprite", "ceiling", "bird"])).toEqual(["ceiling", "bird"]);
    expect(draggedKeys(doc, "camera", ["ceiling", "bird"])).toEqual(["camera"]);
    const t = { kind: "hierarchy" as const, parent: "bird", row: "bird", mode: "into" as const, index: undefined };
    expect(nodeDropProblem(doc, "ceiling", t, ["ceiling", "bird"])).toMatch(/inside itself/);
    expect(nodeDropProblem(doc, "ceiling", { ...t, parent: "camera", row: "camera" }, ["ceiling", "bird"])).toBeNull();
    expect(subtreeRoots(doc, ["bird-sprite", "bird"])).toEqual(["bird"]);
  });
});

describe("hierarchy search", () => {
  it("matches names and shows their ancestors", () => {
    const f = filterHierarchy(scene.doc, "sprite")!;
    expect([...f.matches]).toContain("bird-sprite");
    expect(f.visible.has("bird")).toBe(true);
    expect(f.matches.has("bird")).toBe(false);
    expect(f.visible.has("ceiling")).toBe(false);
    expect(filterHierarchy(scene.doc, "   ")).toBeNull();
  });

  it("matches component types with t:", () => {
    expect(parseHierarchyQuery("t:Camera bird")).toEqual({ words: ["bird"], types: ["camera"] });
    const cams = filterHierarchy(scene.doc, "t:camera")!;
    expect([...cams.matches]).toEqual(["camera"]);
    const colliders = filterHierarchy(scene.doc, "t:BoxCollider2D")!;
    expect(colliders.matches.has("ceiling")).toBe(true);
    expect(colliders.matches.has("ground-collider")).toBe(true);
    // Prefab instances match by their prefab's components.
    const sprites = filterHierarchy(scene.doc, "t:spriterenderer")!;
    expect(sprites.matches.has("bg-a")).toBe(true);
    expect(sprites.matches.has("bird-sprite")).toBe(true);
  });
});
