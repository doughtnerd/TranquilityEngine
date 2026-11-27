// ADR 0246: the node insertion puts new nodes, pasted and duplicated copies, added assets and templates into a
// scene through one interface: one id scheme, names unique among siblings, one set of places (after, into, near,
// inside an instance as an override), references re-pointed, one undo step, one reason when it refuses.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { SpriteRenderer } from "../engine/render/components";
import { AddNode, CommandStack, SceneDocument, type SceneFile } from "./document";
import { copyNodes, cutNodes } from "./nodeClipboard";
import { insertNodes, whyNotInsert, type InsertPlace, type InsertSource } from "./nodeInsertion";
import { OrbitCamera } from "./OrbitCamera";
import { particlesEditorPlugin } from "../plugins/particles/editor";
import { activatePlugins, deactivatePlugin } from "./sdk/plugins";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets } from "./projects";
import { openScene, playState, sceneCamera, type OpenScene } from "./state";
import { sampleProject, useCoreAssetKinds } from "./testing";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

const demo = sampleProject();
const PLUGINS = [particlesEditorPlugin];
beforeAll(() => activatePlugins(PLUGINS));
afterAll(() => PLUGINS.forEach((p) => deactivatePlugin(p.manifest.name)));

/** A scene that isn't open in the editor: its document and an undo stack. */
const sceneOf = (doc: SceneDocument) => ({ doc, stack: new CommandStack(doc) }) as unknown as OpenScene;

let scene: OpenScene;

beforeEach(async () => {
  Input.reset();
  useProjectAssets(demo);
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(demo) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, demo.mainScene!);
  scene = openScene.value!;
});

afterEach(() => {
  playState.value = "edit";
});

/** Insert and return the new keys, failing the test on a refusal. */
function insert(source: InsertSource, place: InsertPlace, into: OpenScene = scene): string[] {
  const made = insertNodes(into, source, place);
  if (!made.ok) throw new Error(made.reason);
  return [...made.keys];
}

const TOP: InsertPlace = { kind: "into", key: null };
const name = (id: string) => scene.doc.node(id).name ?? id;
const addPipe = (id = "pipe") => scene.stack.execute(new AddNode({ id, prefab: "prefabs/pipe-pair.prefab.json" }));

describe("new nodes of a kind (ADR 0022, 0146)", () => {
  it("adds each kind as one undo step with a unique id and name", () => {
    const { doc, stack } = scene;
    const [id] = insert({ kind: "new", node: "camera" }, TOP);
    expect(id).toBe("camera-2"); // the sample has a "camera" already
    expect(name(id!)).toBe("Camera (1)"); // and a top-level "Camera"
    expect(doc.fieldValue(id!, "engine.Camera", "projection")).toBe("orthographic");
    expect(doc.fieldValue(id!, "engine.Transform", "position")).toEqual([0, 0, -10]); // in front of the sprite plane at the top level
    expect(stack.undoLabel).toBe("Create Camera (1)");
    expect(scene.sync.nodeFor(id!)).not.toBeNull();
    stack.undo();
    expect(doc.has(id!)).toBe(false);
  });

  it("creates children under a node, at an index, and at the top level at the given position", () => {
    const { doc } = scene;
    const [sprite] = insert({ kind: "new", node: "sprite", position: [5, 5, 5] }, { kind: "into", key: "bird" });
    expect(doc.parentOf(sprite!)).toBe("bird");
    expect(name(sprite!)).toBe("Sprite (1)"); // Bird already has a child called Sprite
    expect(doc.fieldValue(sprite!, "engine.Transform", "position")).toEqual([0, 0, 0]); // under a parent: at its origin
    const [cube] = insert({ kind: "new", node: "cube" }, { kind: "into", key: null, index: 0 });
    expect(doc.roots()[0]).toBe(cube);
    const [empty] = insert({ kind: "new", node: "empty", position: [1, 2, 0] }, TOP);
    expect(doc.fieldValue(empty!, "engine.Transform", "position")).toEqual([1, 2, 0]);
  });

  it("numbers names among siblings only", () => {
    const doc = new SceneDocument({ format: "myco.scene@1", nodes: [{ id: "a", name: "Node" }, { id: "b", name: "Node (1)" }, { id: "c", name: "Node", parent: "a" }] });
    const [top] = insert({ kind: "new", node: "empty" }, TOP, sceneOf(doc));
    expect(doc.node(top!).name).toBe("Node (2)");
    const [under] = insert({ kind: "new", node: "empty" }, { kind: "into", key: "b" }, sceneOf(doc));
    expect(doc.node(under!).name).toBe("Node");
    const [child] = insert({ kind: "new", node: "empty" }, { kind: "into", key: "a" }, sceneOf(doc));
    expect(doc.node(child!).name).toBe("Node (1)");
  });

  it("says why it can't: an unknown kind, a gone node, play mode", () => {
    expect(whyNotInsert(scene, { kind: "new", node: "nope" }, TOP)).toMatch(/no "nope" node kind/);
    expect(whyNotInsert(scene, { kind: "new", node: "empty" }, { kind: "into", key: "pipe/top" })).toMatch(/gone/);
    expect(whyNotInsert(null, { kind: "new", node: "empty" }, TOP)).toMatch(/open a scene/);
    playState.value = "playing";
    const made = insertNodes(scene, { kind: "new", node: "empty" }, TOP);
    expect(made).toEqual({ ok: false, reason: "stop playing to edit the scene" });
  });
});

describe("places (ADR 0246)", () => {
  it("after a row goes right after it; after a row inside an instance, after the instance", () => {
    const { doc } = scene;
    const [a] = insert({ kind: "new", node: "empty" }, { kind: "after", key: "ceiling" });
    expect(doc.roots()[doc.roots().indexOf("ceiling") + 1]).toBe(a);
    addPipe();
    const [b] = insert({ kind: "new", node: "empty" }, { kind: "after", key: "pipe/top" });
    expect(doc.roots()[doc.roots().indexOf("pipe") + 1]).toBe(b);
    const [c] = insert({ kind: "new", node: "empty" }, { kind: "after", key: null });
    expect(doc.roots().at(-1)).toBe(c);
  });

  it("near the selection goes into it, or right after it when it's a prefab instance or inside one", () => {
    const { doc } = scene;
    const add = (key: string | null) => insert({ kind: "assets", paths: ["images/flappyBird.png"] }, { kind: "near", key })[0]!;
    expect(doc.parentOf(add("bird"))).toBe("bird");
    const beside = add("bg-a");
    expect(doc.roots()[doc.roots().indexOf("bg-a") + 1]).toBe(beside);
    const inner = add("bg-a/inner");
    expect(doc.roots()[doc.roots().indexOf("bg-a") + 1]).toBe(inner);
    const end = add(null);
    expect(doc.roots().at(-1)).toBe(end);
    expect(whyNotInsert(scene, { kind: "assets", paths: ["images/flappyBird.png"] }, { kind: "near", key: "gone" })).toMatch(/gone/);
  });

  it("into a node inside an instance is an addNodes override (ADR 0086), for new nodes, pastes and assets alike", () => {
    addPipe();
    const { doc, sync } = scene;
    const [made] = insert({ kind: "new", node: "empty" }, { kind: "into", key: "pipe/top" });
    expect(made).toBe("pipe/node");
    expect(doc.node("pipe").overrides?.[0]).toMatchObject({ target: ["top"], addNodes: [{ id: "node", name: "Node" }] });
    expect(sync.nodeFor(made!.split("/"))!.parent!.name).toBe("Top");
    const [pasted] = insert({ kind: "copies", clipboard: copyNodes(doc, ["bird"]) }, { kind: "into", key: "pipe/top" });
    expect(pasted).toBe("pipe/bird");
    // A reference to a node outside the pasted ones becomes None inside the instance; one inside them is re-pointed.
    const added = doc.node("pipe").overrides![1]!.addNodes!;
    expect(added.map((n) => n.id)).toEqual(["bird", "bird-sprite"]);
    expect(added[0]!.components!.find((c) => c.type === "game.Bird")!.data!.visual).toEqual({ $node: "bird-sprite" });
    const [sprite] = insert({ kind: "assets", paths: ["images/flappyBird.png"] }, { kind: "into", key: "pipe/top" });
    expect(sprite).toBe("pipe/flappy-bird");
    // Names are unique among the inner node's children; ids among the prefab's and the instance's added nodes.
    const [again] = insert({ kind: "new", node: "empty" }, { kind: "into", key: "pipe/top" });
    expect(again).toBe("pipe/node-2");
    expect(doc.node("pipe").overrides!.at(-1)!.addNodes![0]!.name).toBe("Node (1)");
    scene.stack.undo();
    expect(doc.node("pipe").overrides).toHaveLength(3);
  });
});

describe("copies: paste, duplicate (ADR 0022, 0226)", () => {
  it("pastes with new ids, re-pointing references inside the copy", () => {
    const { doc, stack } = scene;
    const [copy] = insert({ kind: "copies", clipboard: copyNodes(doc, ["bird"]) }, { kind: "after", key: "bird" });
    expect(copy).toBe("bird-2");
    expect(name(copy!)).toBe("Bird (1)");
    expect(doc.roots().indexOf(copy!)).toBe(doc.roots().indexOf("bird") + 1);
    const [child] = doc.children(copy!);
    expect(child).toBe("bird-sprite-2");
    expect(doc.fieldValue(copy!, "game.Bird", "visual")).toEqual({ $node: "bird-sprite-2" });
    expect(doc.fieldValue("bird", "game.Bird", "visual")).toEqual({ $node: "bird-sprite" }); // the original's untouched
    expect(stack.undoLabel).toBe("Paste Bird (1)");
    stack.undo();
    expect(doc.has(copy!)).toBe(false);
    expect(doc.has(child!)).toBe(false);
  });

  it("one id scheme: a free base stays, a taken one gets the next free number (bird-2 → bird-3, not bird-2-2)", () => {
    const { doc } = scene;
    const [two] = insert({ kind: "copies", clipboard: copyNodes(doc, ["bird"]) }, TOP);
    const [three] = insert({ kind: "copies", clipboard: copyNodes(doc, [two!]) }, TOP);
    expect([two, three]).toEqual(["bird-2", "bird-3"]);
    const lone = new SceneDocument({ format: "myco.scene@1", nodes: [{ id: "walk-0", name: "Walk" }] }, "scenes/b.scene.json");
    const empty = new SceneDocument({ format: "myco.scene@1", nodes: [] }, "scenes/c.scene.json");
    expect(insert({ kind: "copies", clipboard: copyNodes(lone, ["walk-0"]) }, TOP, sceneOf(empty))).toEqual(["walk-0"]);
  });

  it("keeps references to other nodes within the same scene, and clears them in another", () => {
    const { doc } = scene;
    const ref = doc.references().find((r) => r.path.length === 1 && r.path[0] !== "bird" && doc.subtree(r.to).length > 0 && !doc.subtree(r.path[0]).includes(r.to))!;
    const clip = copyNodes(doc, [ref.path[0]]);
    const [same] = insert({ kind: "copies", clipboard: clip }, TOP);
    expect(doc.fieldValue(same!, ref.type, ref.field)).toEqual({ $node: ref.to });
    const other = new SceneDocument({ format: "myco.scene@1", nodes: [{ id: ref.to, name: "Lookalike" }] }, "scenes/other.scene.json");
    const [elsewhere] = insert({ kind: "copies", clipboard: clip }, TOP, sceneOf(other));
    expect(other.fieldValue(elsewhere!, ref.type, ref.field)).toBeNull();
  });

  it("copies prefab instances with their overrides, and pastes into a node as its last child", () => {
    const { doc } = scene;
    const [copy] = insert({ kind: "copies", clipboard: copyNodes(doc, ["bg-b"]) }, TOP);
    expect(doc.node(copy!).prefab).toBe("prefabs/background.prefab.json");
    expect(doc.overrides(copy!)).toEqual(doc.overrides("bg-b"));
    const [child] = insert({ kind: "copies", clipboard: copyNodes(doc, ["ceiling"]) }, { kind: "into", key: "bird" });
    expect(doc.children("bird").at(-1)).toBe(child);
    expect(whyNotInsert(scene, { kind: "copies", clipboard: null }, TOP)).toMatch(/nothing/);
  });

  it("pastes into another scene, and cut nodes back under their own ids", () => {
    const clip = copyNodes(scene.doc, ["bird"]);
    const other = new SceneDocument({ format: "myco.scene@1", nodes: [] }, "scenes/empty.scene.json");
    expect(insert({ kind: "copies", clipboard: clip }, TOP, sceneOf(other))).toEqual(["bird"]);
    expect(other.children("bird")).toHaveLength(1);
    const cut = cutNodes(scene, ["bird"]);
    expect(insert({ kind: "copies", clipboard: cut }, TOP)).toEqual(["bird"]); // the id is free again
    expect(scene.doc.fieldValue("bird", "game.Bird", "visual")).toEqual({ $node: "bird-sprite" });
  });

  it("duplicates several nodes, each after itself, as one step", () => {
    const { doc, stack } = scene;
    const made = insertNodes(scene, { kind: "duplicate", keys: ["ceiling", "ground-collider"] });
    expect(made.ok && made.keys).toEqual(["ground-collider-2", "ceiling-2"]);
    const roots = doc.roots();
    expect(roots[roots.indexOf("ceiling") + 1]).toBe("ceiling-2");
    expect(roots[roots.indexOf("ground-collider") + 1]).toBe("ground-collider-2");
    expect(stack.undoLabel).toBe("Duplicate 2 nodes");
    stack.undo();
    expect(doc.has("ceiling-2") || doc.has("ground-collider-2")).toBe(false);
    expect(whyNotInsert(scene, { kind: "duplicate", keys: ["pipe/top"] })).toMatch(/inside a prefab/);
  });

  it("refuses to paste an instance of a prefab the project lacks, naming it; duplicating one keeps it", () => {
    const clip = copyNodes(scene.doc, ["bg-b"]);
    const elsewhere = { ...clip, subtrees: [[{ ...clip.subtrees[0]![0]!, prefab: "prefabs/hills.prefab.json" }]] };
    expect(whyNotInsert(scene, { kind: "copies", clipboard: elsewhere }, TOP)).toBe("the prefab prefabs/hills.prefab.json isn't in this project");
    expect(insertNodes(scene, { kind: "copies", clipboard: elsewhere }, TOP)).toMatchObject({ ok: false, reason: expect.stringMatching(/hills\.prefab\.json/) });
    const nested = { ...clip, subtrees: [[{ id: "n", overrides: [{ addNodes: [{ id: "x", prefab: "prefabs/a.prefab.json" }, { id: "y", prefab: "prefabs/b.prefab.json" }] }] }]] };
    expect(whyNotInsert(scene, { kind: "copies", clipboard: nested }, TOP)).toBe("the prefabs prefabs/a.prefab.json, prefabs/b.prefab.json aren't in this project");
    const broken = new SceneDocument({ format: "myco.scene@1", nodes: [{ id: "hills", prefab: "prefabs/hills.prefab.json" }] }, "scenes/b.scene.json");
    const dup = insertNodes(sceneOf(broken), { kind: "duplicate", keys: ["hills"] });
    expect(dup.ok && dup.keys).toEqual(["hills-2"]);
    expect(broken.node("hills-2").prefab).toBe("prefabs/hills.prefab.json");
  });

  it("refuses to paste a prefab into itself", () => {
    const prefab: SceneFile = { format: "myco.scene@1", nodes: [{ id: "root", name: "Bg" }] };
    const doc = new SceneDocument(prefab, "prefabs/background.prefab.json");
    expect(whyNotInsert(sceneOf(doc), { kind: "copies", clipboard: copyNodes(scene.doc, ["bg-a"]) }, TOP)).toMatch(/inside itself/);
  });
});

describe("assets (ADR 0149)", () => {
  it("adds a prefab instance as one undoable step, twice with distinct ids, keeping the prefab's name", () => {
    const { doc, stack } = scene;
    const first = insert({ kind: "assets", paths: ["prefabs/pipe-pair.prefab.json"] }, TOP);
    const second = insert({ kind: "assets", paths: ["prefabs/pipe-pair.prefab.json"] }, TOP);
    expect([...first, ...second]).toEqual(["pipe-pair", "pipe-pair-2"]);
    expect(doc.node("pipe-pair")).toEqual({ id: "pipe-pair", prefab: "prefabs/pipe-pair.prefab.json" });
    expect(scene.sync.nodeFor("pipe-pair")?.name).toBe("PipePair"); // instantiated in the Editor World
    expect(stack.undoLabel).toBe("Add pipe-pair.prefab.json");
    stack.undo();
    stack.undo();
    expect(doc.has("pipe-pair")).toBe(false);
  });

  it("adds a sprite named after the file, at the given position, named uniquely among its siblings", () => {
    const { doc } = scene;
    const [id] = insert({ kind: "assets", paths: ["images/flappyBird.png"], position: [3, 1, 0] }, { kind: "into", key: "bird" });
    expect(doc.node(id!)).toEqual({
      id: "flappy-bird",
      name: "FlappyBird",
      parent: "bird",
      components: [
        { type: "engine.Transform", data: { position: [3, 1, 0] } },
        { type: "engine.SpriteRenderer", data: { sprite: "asset:images/flappyBird.png" } }, // no size: pixels per unit decides
      ],
    });
    expect(scene.sync.nodeFor(id!)!.getBehavior(SpriteRenderer)!.sprite).toBe("images/flappyBird.png");
    const [again] = insert({ kind: "assets", paths: ["images/flappyBird.png"] }, { kind: "into", key: "bird" });
    expect(doc.node(again!)).toMatchObject({ id: "flappy-bird-2", name: "FlappyBird (1)" });
  });

  it("turns audio into an AudioSource node; several assets go in order from the slot", () => {
    const { doc } = scene;
    const ids = insert({ kind: "assets", paths: ["music/town.mp3", "images/flappyBird.png"], position: [1, 2, 0] }, { kind: "into", key: null, index: 0 });
    expect(doc.roots().slice(0, 2)).toEqual(ids);
    expect(doc.node(ids[0]!)).toMatchObject({ name: "Town", components: [{ type: "engine.Transform", data: { position: [1, 2, 0] } }, { type: "engine.AudioSource", data: { clip: "asset:music/town.mp3" } }] });
  });

  it("instances scenes and prefabs, placed when asked, and refuses self-nesting, folders and files no kind adds", () => {
    const placed = insertNodes(scene, { kind: "assets", paths: ["prefabs/pipe-pair.prefab.json"], position: [3, 4, 0], placeInstances: true }, TOP);
    expect(placed.ok && placed.entries[0]![0]).toMatchObject({ prefab: "prefabs/pipe-pair.prefab.json", overrides: [{ component: "engine.Transform", field: "position", value: [3, 4, 0] }] });
    const kept = insertNodes(scene, { kind: "assets", paths: ["prefabs/pipe-pair.prefab.json"], position: [3, 4, 0] }, TOP);
    expect(kept.ok && kept.entries[0]![0]!.overrides).toBeUndefined();
    const why = (paths: string[]) => whyNotInsert(scene, { kind: "assets", paths }, TOP);
    expect(why(["scenes/main.scene.json"])).toMatch(/inside itself/); // the open scene
    expect(why(["project.json"])).toMatch(/no kind of scene node fits/);
    expect(why(["images/"])).toMatch(/folders/);
    expect(why(["images/flappyBird.png", "project.json"])).toMatch(/^project\.json: /);
  });

  it("adds a particle effect through the Particles plugin's template, named and id'd after the file less its kind's extension", () => {
    const made = insertNodes(scene, { kind: "assets", paths: ["fx/smoke-puff.particles.json"], position: [1, 2, 0] }, TOP);
    expect(made.ok && made.entries[0]![0]).toEqual({
      id: "smoke-puff",
      name: "Smoke-puff",
      components: [
        { type: "engine.Transform", data: { position: [1, 2, 0] } },
        { type: "engine.ParticleSystem", data: { effect: "asset:fx/smoke-puff.particles.json" } },
      ],
    });
  });
});
