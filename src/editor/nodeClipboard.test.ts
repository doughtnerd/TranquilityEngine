import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { CommandStack, SceneDocument, type SceneFile } from "./document";
import { filterHierarchy } from "./hierarchyFilter";
import { moveNodes } from "./hierarchyEdit";
import { createNode, uniqueName } from "./nodeCreate";
import { copyNodes, cutNodes, duplicateNodes, nodeClipboardFromText, nodeClipboardPayload, pasteNodes, pasteTarget, subtreeRoots, whyNotCopyable, whyNotPastable } from "./nodeClipboard";
import { clipboardText } from "./clipboard";
import { nodeDrag, startNodeDrag } from "./nodeDrag";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets } from "./projects";
import { openScene, playState, sceneCamera, select, selectedKeys, status, type OpenScene } from "./state";
import { copySelection, nodeClipboard, pasteClipboard, pasteClipboardText, whyNotPasteAt, whyNotPasteHere } from "./hierarchyActions";
import { sampleProject } from "./testing";

/** A scene that isn't open in the editor, to paste into: its document and an undo stack. */
const sceneOf = (doc: SceneDocument) => ({ doc, stack: new CommandStack(doc) }) as unknown as OpenScene;

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
    expect(() => createNode(scene, "empty", { parent: "pipe/top" })).toThrow(/gone/);
  });

  it("numbers names among siblings only", () => {
    const doc = new SceneDocument({ format: "myco.scene@1", nodes: [{ id: "a", name: "Node" }, { id: "b", name: "Node (1)" }, { id: "c", name: "Node", parent: "a" }] });
    expect(uniqueName(doc, null, "Node")).toBe("Node (2)");
    expect(uniqueName(doc, "b", "Node")).toBe("Node");
    expect(uniqueName(doc, null, "Node (1)")).toBe("Node (2)");
    expect(doc.node(createNode(sceneOf(doc), "empty", { parent: "a" })).name).toBe("Node (1)");
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
    const [same] = pasteNodes(scene, clip, { parent: null });
    expect(doc.fieldValue(same, ref.type, ref.field)).toEqual({ $node: ref.to });
    const other = new SceneDocument({ format: "myco.scene@1", nodes: [{ id: ref.to, name: "Lookalike" }] }, "scenes/other.scene.json");
    const [elsewhere] = pasteNodes(sceneOf(other), clip, { parent: null });
    expect(other.fieldValue(elsewhere, ref.type, ref.field)).toBeNull();
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
    const [root] = pasteNodes(sceneOf(other), clip, { parent: null });
    expect(root).toBe("bird");
    expect(other.children("bird")).toHaveLength(1);
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

  it("pastes nodes copied in another editor from their clipboard text", () => {
    const clip = copyNodes(scene.doc, ["bird"]);
    const read = nodeClipboardFromText(clipboardText(nodeClipboardPayload(clip)));
    expect(read).toEqual(clip);
    const other = new SceneDocument({ format: "myco.scene@1", nodes: [] }, "scenes/empty.scene.json");
    const [root] = pasteNodes(sceneOf(other), read!, { parent: null });
    const names = (doc: SceneDocument, id: string) => doc.subtree(id).map((i) => doc.node(i).name);
    expect(names(other, root)).toEqual(names(scene.doc, "bird"));
    expect(other.fieldValue(root, "game.Bird", "visual")).toEqual({ $node: "bird-sprite" }); // re-pointed inside the copy
  });

  it("reads no nodes from text that isn't well-formed copied nodes", () => {
    const [bird, sprite] = copyNodes(scene.doc, ["bird"]).subtrees[0];
    const text = (subtrees: unknown, extra: object = {}) => JSON.stringify({ format: "myco.nodes@1", source: "scenes/a.scene.json", subtrees, ...extra });
    expect(nodeClipboardFromText(text([[bird, sprite]]))).not.toBeNull();
    expect(nodeClipboardFromText("Bird")).toBeNull(); // plain text
    expect(nodeClipboardFromText(text([[bird, sprite]], { format: "myco.shadergraph.clipboard@1" }))).toBeNull(); // another kind
    expect(nodeClipboardFromText(text([]))).toBeNull(); // nothing in it
    expect(nodeClipboardFromText(text([[sprite, bird]]))).toBeNull(); // a child before its parent
    expect(nodeClipboardFromText(text([[bird], [bird]]))).toBeNull(); // an id twice
    expect(nodeClipboardFromText(text([[{ name: "No id" }]]))).toBeNull();
    expect(nodeClipboardFromText(text([[{ ...bird, components: "none" }]]))).toBeNull();
    expect(nodeClipboardFromText(text([[bird, sprite]], { source: 3 }))).toBeNull();
  });

  it("refuses to paste an instance of a prefab the project lacks, naming it; duplicating one keeps it", () => {
    const clip = copyNodes(scene.doc, ["bg-b"]);
    const elsewhere = { ...clip, subtrees: [[{ ...clip.subtrees[0][0], prefab: "prefabs/hills.prefab.json" }]] };
    expect(whyNotPastable(scene.doc, elsewhere, null)).toBe("the prefab prefabs/hills.prefab.json isn't in this project");
    expect(() => pasteNodes(scene, elsewhere, { parent: null })).toThrow(/hills\.prefab\.json/);
    const nested = { ...clip, subtrees: [[{ id: "n", overrides: [{ addNodes: [{ id: "x", prefab: "prefabs/a.prefab.json" }, { id: "y", prefab: "prefabs/b.prefab.json" }] }] }]] };
    expect(whyNotPastable(scene.doc, nested, null)).toBe("the prefabs prefabs/a.prefab.json, prefabs/b.prefab.json aren't in this project");
    expect(whyNotPastable(scene.doc, clip, null)).toBeNull();
    const broken = new SceneDocument({ format: "myco.scene@1", nodes: [{ id: "hills", prefab: "prefabs/hills.prefab.json" }] }, "scenes/b.scene.json");
    expect(duplicateNodes(sceneOf(broken), ["hills"])).toEqual(["hills-2"]);
    expect(broken.node("hills-2").prefab).toBe("prefabs/hills.prefab.json");
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
    // A hierarchy panel in a window of its own: rows 20px tall, one per key, the pointer at y = 20 * row + 10 (the middle).
    const rows = ["bird", "camera", "ceiling"];
    const rowAt = (y: number) => {
      const key = rows[Math.floor(y / 20)];
      const row = { dataset: { key }, getBoundingClientRect: () => ({ top: Math.floor(y / 20) * 20, height: 20 }) };
      return { closest: (sel: string) => (sel === ".panel.hierarchy" ? {} : sel === ".tree .row" ? row : null) };
    };
    const win = Object.assign(new EventTarget(), { document: { elementFromPoint: (_x: number, y: number) => rowAt(y) } });
    const pointer = (type: string, y: number) => Object.assign(new Event(type), { clientX: 0, clientY: y, button: 0, view: win });
    const middleOf = (key: string) => rows.indexOf(key) * 20 + 10;

    select(["bird-sprite", "ceiling", "bird"]);
    startNodeDrag(pointer("pointerdown", middleOf("bird")) as unknown as PointerEvent, "bird");
    win.dispatchEvent(pointer("pointermove", middleOf("bird") + 1)); // under the threshold: still a click
    expect(nodeDrag.value).toBeNull();
    win.dispatchEvent(pointer("pointermove", middleOf("bird") + 8)); // below Bird
    expect(nodeDrag.value?.keys).toEqual(["ceiling", "bird"]);
    win.dispatchEvent(pointer("pointermove", middleOf("bird"))); // into Bird
    expect(nodeDrag.value?.problem).toMatch(/inside itself/);
    win.dispatchEvent(pointer("pointermove", middleOf("camera")));
    expect(nodeDrag.value).toMatchObject({ problem: null, target: { parent: "camera", mode: "into" } });
    win.dispatchEvent(pointer("pointerup", middleOf("camera")));
    expect(nodeDrag.value).toBeNull();
    expect(doc.children("camera").slice(-2)).toEqual(["ceiling", "bird"]);
    expect(selectedKeys.value).toEqual(["ceiling", "bird"]);

    // A row outside the selection drags just itself.
    startNodeDrag(pointer("pointerdown", middleOf("camera")) as unknown as PointerEvent, "camera");
    win.dispatchEvent(pointer("pointermove", middleOf("camera") + 30));
    expect(nodeDrag.value?.keys).toEqual(["camera"]);
    win.dispatchEvent(pointer("pointercancel", 0));
    expect(nodeDrag.value).toBeNull();
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
    const cams = filterHierarchy(scene.doc, "t:camera")!;
    expect([...cams.matches]).toEqual(["camera"]);
    const colliders = filterHierarchy(scene.doc, "t:BoxCollider2D")!;
    expect(colliders.matches.has("ceiling")).toBe(true);
    expect(colliders.matches.has("ground-collider")).toBe(true);
    // Prefab instances match by their prefab's components.
    const sprites = filterHierarchy(scene.doc, "t:spriterenderer")!;
    expect(sprites.matches.has("bg-a")).toBe(true);
    expect(sprites.matches.has("bird-sprite")).toBe(true);
    // Types and words together, in any case: both must match.
    const colliderCeiling = filterHierarchy(scene.doc, "T:BoxCollider2D  CEIL")!;
    expect([...colliderCeiling.matches]).toEqual(["ceiling"]);
    expect(filterHierarchy(scene.doc, "t:")).toBeNull(); // a bare "t:" is no query
  });
});

describe("the hierarchy's paste action", () => {
  it("says paste is unavailable while playing, as pasting refuses then", () => {
    select(["camera"]);
    expect(copySelection()).toBe(true);
    expect(whyNotPasteHere()).toBeNull();
    playState.value = "playing";
    try {
      expect(whyNotPasteHere()).toBe("stop playing to edit the scene");
      expect(whyNotPasteAt(null)).toBe("stop playing to edit the scene");
      expect(pasteClipboard()).toBe(false);
    } finally {
      playState.value = "edit";
    }
    expect(pasteClipboard()).toBe(true);
  });

  describe("with the system clipboard's text", () => {
    let system = "";
    beforeEach(() => {
      system = "";
      vi.stubGlobal("navigator", { clipboard: { writeText: (t: string) => ((system = t), Promise.resolve()) } });
    });
    afterEach(() => void vi.unstubAllGlobals());

    /** Nodes copied in another editor process: a scene of its own, written as that editor writes them. */
    const copiedElsewhere = () => {
      const doc = new SceneDocument({ format: "myco.scene@1", nodes: [{ id: "lamp", name: "Lamp" }] }, "scenes/far.scene.json");
      return clipboardText(nodeClipboardPayload(copyNodes(doc, ["lamp"])));
    };

    it("pastes nodes copied in another editor since this one's copy, which become its clipboard", async () => {
      select(["camera"]);
      copySelection();
      await Promise.resolve();
      expect(pasteClipboardText(copiedElsewhere())).toBe(true);
      expect(selectedKeys.value.map(name)).toEqual(["Lamp"]);
      expect(nodeClipboard.value?.source).toBe("scenes/far.scene.json");
    });

    it("pastes its own copy when the text is what it wrote, or isn't nodes", async () => {
      select(["camera"]);
      copySelection();
      await Promise.resolve();
      expect(pasteClipboardText(system)).toBe(true);
      expect(selectedKeys.value.map(name)).toEqual(["Camera (1)"]);
      expect(pasteClipboardText('{"format":"myco.nodes@1","subtrees":"broken"}')).toBe(true);
      expect(pasteClipboardText("hello")).toBe(true);
      expect(scene.doc.roots().filter((id) => name(id).startsWith("Camera"))).toHaveLength(4);
    });

    it("says why when the text's nodes instance a prefab this project lacks", () => {
      nodeClipboard.value = null;
      const text = JSON.stringify({ format: "myco.nodes@1", source: "scenes/far.scene.json", subtrees: [[{ id: "hills", prefab: "prefabs/hills.prefab.json" }]] });
      expect(pasteClipboardText(text)).toBe(false);
      expect(status.value?.text).toBe("Can't paste: the prefab prefabs/hills.prefab.json isn't in this project.");
    });
  });
});
