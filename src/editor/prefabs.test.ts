import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, SpriteRenderer } from "../engine";
import { AddNode, RevertOverrides, SetField, type SceneFile } from "./document";
import { OrbitCamera } from "./OrbitCamera";
import { applyOverrides, createPrefab, findInner, innerNodes, isOverridden, newPrefabPath, prefabFileName } from "./prefabs";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { currentProject, openScene, sceneCamera } from "./state";
import { MemoryFileSystem, ROOT, demoFolder } from "./testing";

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

describe("prefab structure (ADR 0013)", () => {
  it("lists the nodes inside an instance from its prefab file", () => {
    addPipe();
    const inner = innerNodes("prefabs/pipe-pair.prefab.json", ["pipe"]);
    expect(inner.map((n) => n.name)).toEqual(["Top", "Bottom", "ScoreGate"]);
    expect(inner[0].path).toEqual(["pipe", "top"]);
    expect(findInner(openScene.value!.doc, ["pipe", "bottom"])?.name).toBe("Bottom");
    expect(findInner(openScene.value!.doc, ["pipe", "nope"])).toBeNull();
  });

  it("an instance whose prefab is a single node has no inner nodes", () => {
    expect(innerNodes("prefabs/background.prefab.json", ["bg-a"])).toEqual([]);
  });
});

describe("overrides on nodes inside a prefab instance", () => {
  it("edits an inner node as an override, and reverting puts the prefab's value back", () => {
    addPipe();
    const { doc, stack, sync } = openScene.value!;
    stack.execute(new SetField("pipe", "engine.Transform", "position", [0, 12, 0], { target: ["top"] }));
    expect(isOverridden(doc, ["pipe", "top"], "engine.Transform", "position")).toBe(true);
    expect(isOverridden(doc, ["pipe", "bottom"], "engine.Transform", "position")).toBe(false);
    expect(sync.nodeFor(["pipe", "top"])!.transform!.position.y).toBe(12);

    stack.execute(new RevertOverrides("pipe", "Revert position", (o) => o.field === "position"));
    expect(isOverridden(doc, ["pipe", "top"], "engine.Transform", "position")).toBe(false);
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
    expect(await applyOverrides(scene, project, "bg-a")).toBe(1);

    const tile = fileOf("prefabs/background.prefab.json").nodes[0];
    expect(tile.components!.find((c) => c.type === "engine.SpriteRenderer")!.data!.color).toBe("#ff0000");
    expect(scene.doc.node("bg-a").overrides).toBeUndefined();
    // The other instance shows the new prefab value and keeps its own position override.
    const bgB = scene.sync.nodeFor("bg-b")!;
    expect(bgB.getBehavior(SpriteRenderer)!.color.toHex()).toBe("#ff0000");
    expect(bgB.transform!.position.x).toBe(32);
    expect(scene.stack.undoLabel).toBe("Apply to background.prefab.json");
  });

  it("refuses in a read-only project", async () => {
    const scene = openScene.value!;
    scene.stack.execute(new SetField("bg-a", "engine.SpriteRenderer", "color", "#ff0000"));
    const readOnly = { ...project, canSave: false, name: "Demo" } as EditorProject;
    await expect(applyOverrides(scene, readOnly, "bg-a")).rejects.toThrow(/read-only/);
  });
});

describe("Create Prefab (ADR 0022)", () => {
  it("names files safely and avoids existing ones", () => {
    expect(prefabFileName("GroundCollider")).toBe("ground-collider");
    expect(prefabFileName("  My Pipe #2 ")).toBe("my-pipe-2");
    expect(newPrefabPath(project, "Ground")).toBe("prefabs/ground-2.prefab.json"); // ground.prefab.json exists
  });

  it("turns a node into a prefab file plus an instance in the same place", async () => {
    const scene = openScene.value!;
    const before = scene.sync.nodeFor("bird")!.transform!.position.toArray();
    const path = await createPrefab(scene, project, "bird");
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
