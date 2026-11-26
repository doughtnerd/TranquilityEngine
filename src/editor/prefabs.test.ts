import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { SpriteRenderer } from "../engine/render/components";
import { AddNode, RevertOverrides, SetField, SetOverrides, type SceneFile } from "./document";
import { OrbitCamera } from "./OrbitCamera";
import { createPrefabFromNodes, applyOverridesTo, createPrefab, findInner, instanceInnerNodes } from "./prefabs";
import { isOverridden, writeRemoveNode } from "./overrideWriter";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, openScene, sceneCamera } from "./state";
import { MemoryFileSystem, ROOT, demoFolder, insertNew } from "./testing";
import { insertNodes } from "./nodeInsertion";
import type { NodeTemplate } from "./sdk/contributions";

const POSITION = { kind: "field", type: "engine.Transform", index: 0, field: "position" } as const;

let fs: MemoryFileSystem;
let project: EditorProject;

beforeEach(async () => {
  Input.reset();
  fs = demoFolder();
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
});

const fileOf = (path: string) => JSON.parse(fs.files.get(joinPath(ROOT, path)) as string) as SceneFile;

/** Add a pipe-pair instance to the open scene. */
function addPipe(id = "pipe"): void {
  openScene.value!.stack.execute(new AddNode({ id, prefab: "prefabs/pipe-pair.prefab.json" }));
}

/** Insert `node` under the inner row `key` through the node insertion (an `addNodes` override, ADR 0086, 0246); its path. */
function insertInside(key: string, node: NodeTemplate): string[] {
  const made = insertNodes(openScene.value!, { kind: "template", nodes: [node], label: "Add" }, { kind: "into", key });
  if (!made.ok) throw new Error(made.reason);
  return made.keys[0]!.split("/");
}

describe("prefab structure (ADR 0013)", () => {
  it("lists the nodes inside an instance from its prefab file", () => {
    addPipe();
    const inner = instanceInnerNodes(openScene.value!.doc, "pipe");
    expect(inner.map((n) => n.name)).toEqual(["Top", "Bottom", "ScoreGate"]);
    expect(inner[0].path).toEqual(["pipe", "top"]);
    expect(findInner(openScene.value!.doc, ["pipe", "bottom"])?.name).toBe("Bottom");
    expect(findInner(openScene.value!.doc, ["pipe", "nope"])).toBeNull();
  });

  it("an instance whose prefab is a single node has no inner nodes", () => {
    expect(instanceInnerNodes(openScene.value!.doc, "bg-a")).toEqual([]);
  });
});

describe("overrides on nodes inside a prefab instance", () => {
  it("edits an inner node as an override, and reverting puts the prefab's value back", () => {
    addPipe();
    const { doc, stack, sync } = openScene.value!;
    stack.execute(new SetField("pipe", "engine.Transform", "position", [0, 12, 0], { target: ["top"] }));
    expect(isOverridden(doc, ["pipe", "top"], POSITION)).toBe(true);
    expect(isOverridden(doc, ["pipe", "bottom"], POSITION)).toBe(false);
    expect(sync.nodeFor(["pipe", "top"])!.transform!.position.y).toBe(12);

    stack.execute(new RevertOverrides("pipe", "Revert position", (o) => o.field === "position"));
    expect(isOverridden(doc, ["pipe", "top"], POSITION)).toBe(false);
    expect(doc.node("pipe").overrides).toBeUndefined();
    expect(sync.nodeFor(["pipe", "top"])!.transform!.position.y).toBeCloseTo(9.6, 4); // from the prefab

    stack.undo();
    expect(sync.nodeFor(["pipe", "top"])!.transform!.position.y).toBe(12);
  });
});

describe("Apply (ADR 0022)", () => {
  it("writes overrides into the prefab file and refreshes every instance", async () => {
    const scene = openScene.value!;
    scene.stack.execute(new SetField("bg-a", "engine.SpriteRenderer", "color", "#ff0000"));
    expect(await applyOverridesTo(scene, project, ["bg-a"])).toBe(1);

    const tile = fileOf("prefabs/background.prefab.json").nodes[0];
    expect(tile.components!.find((c) => c.type === "engine.SpriteRenderer")!.data!.color).toBe("#ff0000");
    expect(scene.doc.node("bg-a").overrides).toBeUndefined();
    // The other instance shows the new prefab value and keeps its own position override.
    const bgB = scene.sync.nodeFor("bg-b")!;
    expect(bgB.getBehavior(SpriteRenderer)!.color.toHex()).toBe("#ff0000");
    expect(bgB.transform!.position.x).toBe(32);
    expect(scene.stack.undoLabel).toBe("Apply to background.prefab.json");
  });

  it("writes added, removed and switched-off components into the prefab, nested instances too", async () => {
    const scene = openScene.value!;
    addPipe();
    scene.stack.execute(
      new SetOverrides("bg-a", "components", [
        { addComponent: { type: "engine.BoxCollider2D", data: { size: [3, 3] } } },
        { component: "engine.BoxCollider2D", field: "isTrigger", value: true }, // a field of the added box
        { removeComponent: "game.Scroller" },
        { component: "engine.SpriteRenderer", enabled: false },
      ]),
    );
    expect(await applyOverridesTo(scene, project, ["bg-a"])).toBe(4);
    const tile = fileOf("prefabs/background.prefab.json").nodes[0];
    expect(tile.components!.map((c) => c.type)).toEqual(["engine.Transform", "engine.SpriteRenderer", "engine.BoxCollider2D"]);
    expect(tile.components![1].enabled).toBe(false);
    expect(tile.components![2]).toEqual({ type: "engine.BoxCollider2D", data: { size: [3, 3], isTrigger: true } });
    expect(scene.sync.nodeFor("bg-b")!.getBehavior(SpriteRenderer)!.enabled).toBe(false); // the other instance follows

    // Inside the pipe: the top node is plain in pipe-pair.prefab.json, so it's edited directly.
    scene.stack.execute(new SetOverrides("pipe", "components", [{ target: ["top"], component: "engine.BoxCollider2D", enabled: false }]));
    expect(await applyOverridesTo(scene, project, ["pipe"])).toBe(1);
    const top = fileOf("prefabs/pipe-pair.prefab.json").nodes.find((n) => n.id === "top")!;
    expect(top.components!.find((c) => c.type === "engine.BoxCollider2D")!.enabled).toBe(false);
  });

  it("writes a component's Worlds override into the prefab (ADR 0042)", async () => {
    const scene = openScene.value!;
    scene.stack.execute(new SetOverrides("bg-a", "Set Worlds", [{ component: "game.Scroller", worlds: ["client"] }]));
    expect(await applyOverridesTo(scene, project, ["bg-a"])).toBe(1);
    const tile = fileOf("prefabs/background.prefab.json").nodes[0];
    expect(tile.components!.find((c) => c.type === "game.Scroller")).toEqual({ type: "game.Scroller", worlds: ["client"], data: { speed: 0.5, wrapWidth: 32 } });
  });

  it("writes an order override as the prefab's component order, leaving Transform and data components in place", async () => {
    const scene = openScene.value!;
    scene.stack.execute(
      new SetOverrides("bg-a", "order", [{ addComponent: { type: "engine.CircleCollider2D" } }, { order: ["engine.CircleCollider2D", "engine.SpriteRenderer"] }]),
    );
    expect(await applyOverridesTo(scene, project, ["bg-a"])).toBe(2);
    const tile = fileOf("prefabs/background.prefab.json").nodes[0];
    expect(tile.components!.map((c) => c.type)).toEqual(["engine.Transform", "engine.CircleCollider2D", "game.Scroller", "engine.SpriteRenderer"]);

    addPipe();
    scene.stack.execute(new SetOverrides("pipe", "order", [{ target: ["top"], order: ["engine.BoxCollider2D", "engine.SpriteRenderer"] }]));
    await applyOverridesTo(scene, project, ["pipe"]);
    const top = fileOf("prefabs/pipe-pair.prefab.json").nodes.find((n) => n.id === "top")!;
    expect(top.components!.map((c) => c.type)).toEqual(["engine.Transform", "engine.BoxCollider2D", "engine.SpriteRenderer"]);
  });

  it("refuses in a read-only project", async () => {
    const scene = openScene.value!;
    scene.stack.execute(new SetField("bg-a", "engine.SpriteRenderer", "color", "#ff0000"));
    const readOnly = { ...project, canSave: false, name: "Demo" } as EditorProject;
    await expect(applyOverridesTo(scene, readOnly, ["bg-a"])).rejects.toThrow(/read-only/);
  });
});

describe("Create Prefab (ADR 0022)", () => {
  it("names files safely and avoids existing ones", async () => {
    const scene = openScene.value!;
    expect((await createPrefabFromNodes(scene, project, ["ceiling", "ground-collider"], "GroundCollider")).path).toBe("prefabs/ground-collider.prefab.json");
    expect((await createPrefabFromNodes(scene, project, ["bg-a", "bg-b"], "  My Pipe #2 ")).path).toBe("prefabs/my-pipe-2.prefab.json");
    expect((await createPrefabFromNodes(scene, project, ["ground-a", "ground-b"], "Ground")).path).toBe("prefabs/ground-2.prefab.json"); // ground.prefab.json exists
  });

  it("turns a node into a prefab file plus an instance in the same place", async () => {
    const scene = openScene.value!;
    const before = scene.sync.nodeFor("bird")!.transform!.position.toArray();
    const { path } = await createPrefab(scene, project, "bird");
    expect(path).toBe("prefabs/bird.prefab.json");

    const file = fileOf(path);
    expect(file.nodes.map((n) => n.id)).toEqual(["bird", "bird-sprite"]);
    expect(file.nodes[0].parent).toBeUndefined();
    expect(scene.doc.node("bird")).toEqual({ id: "bird", name: "Bird", prefab: path });
    expect(scene.doc.has("bird-sprite")).toBe(false);
    expect(scene.sync.nodeFor("bird")!.transform!.position.toArray()).toEqual(before);
    expect(scene.sync.nodeFor(["bird", "bird-sprite"])).not.toBeNull();
    expect(project.files).toContain(path);

    scene.stack.undo(); // one step back to the plain node and its child
    expect(scene.doc.node("bird").prefab).toBeUndefined();
    expect(scene.doc.has("bird-sprite")).toBe(true);
  });

  it("refuses when outside nodes reference nodes inside the new prefab", async () => {
    const scene = openScene.value!;
    scene.stack.execute(new SetField("game", "game.GameManager", "bird", { $node: "bird-sprite" }));
    await expect(createPrefab(scene, project, "bird")).rejects.toThrow(/references "bird-sprite"/);
  });
});

describe("Create Prefab with references out of the new prefab (ADR 0401)", () => {
  const OUT = ["spawner", "score", "message", "music-readout"];
  /** The resolved component data of the node at `path` (slash-joined) in the scene. */
  const dataAt = (path: string) => openScene.value!.doc.resolve().nodes.find((n) => n.path.join("/") === path)!.components.map((c) => c.data ?? null);

  it("leaves outside references empty in the file and keeps them on the instance as overrides; one undo step", async () => {
    const scene = openScene.value!;
    const before = dataAt("game");
    const made = await createPrefab(scene, project, "game");
    expect(made.instanceOverrides).toBe(5);
    const manager = fileOf(made.path).nodes[0].components!.find((c) => c.type === "game.GameManager")!;
    expect(manager.data).toEqual({ bird: null, spawner: null, scoreLabel: null, messageLabel: null, musicLabel: null });
    expect(scene.doc.node("game").overrides).toEqual([
      { component: "game.GameManager", index: 0, field: "bird", value: { $node: "bird" } },
      { component: "game.GameManager", index: 0, field: "spawner", value: { $node: "spawner" } },
      { component: "game.GameManager", index: 0, field: "scoreLabel", value: { $node: "score" } },
      { component: "game.GameManager", index: 0, field: "messageLabel", value: { $node: "message" } },
      { component: "game.GameManager", index: 0, field: "musicLabel", value: { $node: "music-readout" } },
    ]);
    expect(dataAt("game")).toEqual(before); // the scene is as it was
    expect(scene.doc.references().filter((r) => r.path[0] === "game").map((r) => r.to)).toEqual(["bird", ...OUT]);

    scene.stack.undo();
    expect(scene.doc.node("game").prefab).toBeUndefined();
    expect(scene.doc.node("game").overrides).toBeUndefined();
  });

  it("keeps references inside the new prefab, the root included, and makes no overrides for them", async () => {
    const scene = openScene.value!;
    scene.stack.execute(new SetField("bird-sprite", "engine.SpriteRenderer", "follow", [{ $node: "bird" }, null, { $node: "bird-sprite" }]));
    const made = await createPrefab(scene, project, "bird");
    expect(made.instanceOverrides).toBe(0);
    const [bird, sprite] = fileOf(made.path).nodes;
    expect(bird.components!.find((c) => c.type === "game.Bird")!.data).toEqual({ visual: { $node: "bird-sprite" } });
    expect(sprite.components![0].data!.follow).toEqual([{ $node: "bird" }, null, { $node: "bird-sprite" }]);
    expect(scene.doc.node("bird").overrides).toBeUndefined();
  });

  it("several nodes: references between them stay in the file, the rest become overrides aimed at their node", async () => {
    const scene = openScene.value!;
    const before = dataAt("game");
    const path = (await createPrefabFromNodes(scene, project, ["bird", "game"], "Group")).path;
    const file = fileOf(path);
    const manager = file.nodes.find((n) => n.id === "game")!.components!.find((c) => c.type === "game.GameManager")!;
    expect(manager.data).toEqual({ bird: { $node: "bird" }, spawner: null, scoreLabel: null, messageLabel: null, musicLabel: null });
    expect(file.nodes.find((n) => n.id === "bird")!.components!.find((c) => c.type === "game.Bird")!.data).toEqual({ visual: { $node: "bird-sprite" } });
    const instance = scene.doc.nodes.find((n) => n.prefab === path)!;
    expect(instance.overrides).toEqual([
      { target: ["game"], component: "game.GameManager", index: 0, field: "spawner", value: { $node: "spawner" } },
      { target: ["game"], component: "game.GameManager", index: 0, field: "scoreLabel", value: { $node: "score" } },
      { target: ["game"], component: "game.GameManager", index: 0, field: "messageLabel", value: { $node: "message" } },
      { target: ["game"], component: "game.GameManager", index: 0, field: "musicLabel", value: { $node: "music-readout" } },
    ]);
    expect(dataAt(`${instance.id}/game`)).toEqual(before);
    scene.stack.undo();
    expect(scene.doc.has("game") && scene.doc.has("bird")).toBe(true);
    expect(scene.doc.nodes.some((n) => n.prefab === path)).toBe(false);
  });

  it("nested prefab instances: their overrides and added components that point out move to the new instance", async () => {
    const scene = openScene.value!;
    scene.stack.execute(
      new SetOverrides("bg-a", "Set", [
        ...scene.doc.overrides("bg-a"),
        { component: "engine.SpriteRenderer", field: "follow", value: { $node: "score" } },
        { addComponent: { type: "engine.SpriteRenderer", data: { sprite: "x", path: [{ $node: "message" }, null] } } },
      ]),
    );
    const before = dataAt("bg-a");
    const made = await createPrefabFromNodes(scene, project, ["bg-a", "camera"], "Group");
    expect(made.instanceOverrides).toBe(2);
    const nested = fileOf(made.path).nodes.find((n) => n.id === "bg-a")!;
    expect(nested.overrides).toContainEqual({ component: "engine.SpriteRenderer", field: "follow", value: null });
    expect(nested.overrides).toContainEqual({ addComponent: { type: "engine.SpriteRenderer", data: { sprite: "x", path: [null, null] } } });
    const instance = scene.doc.nodes.find((n) => n.prefab === made.path)!;
    expect(instance.overrides).toEqual([
      { target: ["bg-a"], component: "engine.SpriteRenderer", index: 0, field: "follow", value: { $node: "score" } },
      { target: ["bg-a"], component: "engine.SpriteRenderer", index: 1, field: "path", value: [{ $node: "message" }, null] },
    ]);
    expect(dataAt(`${instance.id}/bg-a`)).toEqual(before);
  });

  it("keeps a list mixing references into the prefab with ones out of it in the file, and clears the inside ones in the override", async () => {
    const scene = openScene.value!;
    scene.stack.execute(new SetField("bird-sprite", "engine.SpriteRenderer", "follow", [{ $node: "bird-sprite" }, { $node: "score" }, { $node: "bird" }]));
    const made = await createPrefab(scene, project, "bird");
    expect(made.droppedListItems).toBe(1);
    const file = fileOf(made.path).nodes.find((n) => n.id === "bird-sprite")!;
    expect(file.components!.find((c) => c.type === "engine.SpriteRenderer")!.data!.follow).toEqual([{ $node: "bird-sprite" }, null, { $node: "bird" }]);
    const override = scene.doc.node("bird").overrides!.find((o) => o.field === "follow")!;
    expect(override.value).toEqual([null, { $node: "score" }, { $node: "bird" }]);
  });
});

describe("child node overrides (ADR 0086)", () => {
  it("adds a node under an inner node, edits it, undoes, and applies it into the prefab", async () => {
    addPipe();
    const { doc, stack, sync } = openScene.value!;
    const path = insertInside("pipe/top", { name: "Spike", components: [{ type: "engine.Transform", data: { position: [0, 1, 0] } }] });
    expect(path).toEqual(["pipe", "spike"]);
    const added = sync.nodeFor(path)!;
    expect(added.name).toBe("Spike");
    expect(added.parent!.name).toBe("Top");
    stack.execute(new SetField("pipe", "engine.Transform", "position", [0, 5, 0], { target: ["spike"] }));
    expect(sync.nodeFor(path)!.transform!.position.y).toBe(5);
    stack.undo();
    stack.undo();
    expect(doc.node("pipe").overrides).toBeUndefined();
    stack.redo();
    const { project: _p } = { project };
    await applyOverridesTo(openScene.value!, project, ["pipe"]);
    const file = fileOf("prefabs/pipe-pair.prefab.json");
    expect(file.nodes.find((n) => n.id === "spike")).toMatchObject({ name: "Spike", parent: "top" });
    expect(doc.node("pipe").overrides).toBeUndefined();
  });

  it("removes a prefab node as an override and writes the removal on Apply", async () => {
    addPipe();
    const { doc, sync } = openScene.value!;
    openScene.value!.stack.execute(writeRemoveNode(openScene.value!.doc, ["pipe", "bottom"]));
    expect(doc.node("pipe").overrides).toEqual([{ target: ["bottom"], removeNode: true }]);
    expect(sync.nodeFor(["pipe", "bottom"])?.isValid ?? false).toBe(false);
    await applyOverridesTo(openScene.value!, project, ["pipe"]);
    expect(fileOf("prefabs/pipe-pair.prefab.json").nodes.some((n) => n.id === "bottom")).toBe(false);
  });

  it("removing an added node drops its override", () => {
    addPipe();
    const path = insertInside("pipe/top", { name: "X" });
    openScene.value!.stack.execute(writeRemoveNode(openScene.value!.doc, path));
    expect(openScene.value!.doc.node("pipe").overrides).toBeUndefined();
  });
});

describe("multi-node prefabs (ADR 0087)", () => {
  it("turns sibling nodes into one prefab under a Group root", async () => {
    const { doc } = openScene.value!;
    const roots = doc.roots().slice(0, 2);
    const { path } = await createPrefabFromNodes(openScene.value!, project, roots, "Pair");
    const file = fileOf(path);
    expect(file.nodes[0]).toMatchObject({ name: "Pair" });
    expect(file.nodes.filter((n) => n.parent === file.nodes[0].id).map((n) => n.id)).toEqual(roots);
    expect(roots.some((id) => doc.has(id))).toBe(false);
    expect(doc.nodes.find((n) => n.prefab === path)).toBeDefined();
    openScene.value!.stack.undo();
    expect(roots.every((id) => doc.has(id))).toBe(true);
  });

  it("refuses nodes with different parents", async () => {
    const { doc } = openScene.value!;
    const child = doc.nodes.find((n) => n.parent)!;
    await expect(createPrefabFromNodes(openScene.value!, project, [doc.roots()[0], child.id])).rejects.toThrow(/share a parent/);
  });
});

describe("creating a child inside an instance (ADR 0086)", () => {
  it("a new node under an inner row is an override", () => {
    addPipe();
    const key = insertNew(openScene.value!, "empty", { parent: "pipe/top" });
    expect(key.startsWith("pipe/")).toBe(true);
    expect(openScene.value!.doc.node("pipe").overrides?.[0]).toMatchObject({ target: ["top"] });
    expect(openScene.value!.sync.nodeFor(key.split("/"))!.parent!.name).toBe("Top");
  });
});
