import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { OrbitCamera } from "./OrbitCamera";
import { layerRenamesBetween, layerUsers, renameLayerReferences, type LayerKind } from "./layerRename";
import { openSceneFile } from "./project";
import { renameSortingLayer, moveSortingLayer, type SettingsDraft } from "./projectSettingsModel";
import { addLayer, renameLayer } from "../plugins/physics/editor/physicsSettingsModel";
import { editorSettings, joinPath, openFolderProject, useProjectAssets } from "./projects";
import { currentProject, openScene, sceneCamera } from "./state";
import { MemoryFileSystem, ROOT } from "./testing";

const scene = (data: unknown) => ({ format: "myco.scene@1", nodes: [data] });
const collider = (layer: string) => ({ type: "engine.BoxCollider2D", data: { layer } });

/** Rename a layer in a project holding one prefab file, `json`: the files changed and the prefab as parsed afterwards, as JSON text. */
async function renamedIn(json: unknown, kind: LayerKind, from: string, to: string): Promise<{ done: string[]; text: string }> {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), JSON.stringify({ name: "t" }));
  fs.files.set(joinPath(ROOT, "x.prefab.json"), JSON.stringify(json, null, 2));
  const project = await openFolderProject(fs, ROOT);
  openScene.value = null;
  const done = await renameLayerReferences(project, [{ kind, from, to }]);
  return { done, text: JSON.stringify(JSON.parse(project.textOf("x.prefab.json")!)) };
}

describe("renaming a layer in a scene file (ADR 0116)", () => {
  it("renames collider layers and sprite sorting layers, each only for its own kind", async () => {
    const json = scene({ id: "a", name: "A", components: [collider("Ground"), { type: "engine.SpriteRenderer", data: { sortingLayer: "Ground" } }, { type: "game.Thing", data: { layer: "Ground" } }] });
    const phys = (await renamedIn(json, "physics", "Ground", "Floor")).text;
    expect(phys.match(/"Floor"/g)).toHaveLength(1);
    expect(phys).toContain('"layer":"Floor"');
    expect(phys).toContain('"sortingLayer":"Ground"'); // untouched
    expect(phys).toContain('{"type":"game.Thing","data":{"layer":"Ground"}}'); // not a collider
    const sort = (await renamedIn(json, "sorting", "Ground", "Floor")).text;
    expect(sort.match(/"Floor"/g)).toHaveLength(1);
    expect(sort).toContain('"sortingLayer":"Floor"');
  });

  it("renames prefab overrides and nested nodes, and leaves a file that doesn't name the layer alone", async () => {
    const json = scene({ id: "i", name: "I", prefab: "p.prefab.json", children: [{ id: "c", components: [collider("A")] }], overrides: [{ target: ["x"], component: "engine.CircleCollider2D", field: "layer", value: "A" }, { target: ["x"], component: "game.Thing", field: "layer", value: "A" }] });
    const r = await renamedIn(json, "physics", "A", "B");
    expect(r.done).toEqual(["x.prefab.json"]);
    expect(r.text.match(/"B"/g)).toHaveLength(2);
    expect(r.text).toContain('"value":"B"');
    expect(r.text.match(/"value":"A"/g)).toHaveLength(1);
    expect((await renamedIn(json, "physics", "Zed", "Q")).done).toEqual([]);
  });
});

describe("layerRenamesBetween", () => {
  const base: SettingsDraft = { physics: { layers: ["Default", "Ground"] }, render: { sortingLayers: ["Default", "Fx"] } };
  it("recognises a single rename of either kind", () => {
    expect(layerRenamesBetween(base, renameLayer(base, 1, "Floor"))).toEqual([{ kind: "physics", from: "Ground", to: "Floor" }]);
    expect(layerRenamesBetween(base, renameSortingLayer(base, 1, "Glow"))).toEqual([{ kind: "sorting", from: "Fx", to: "Glow" }]);
  });
  it("ignores adds, reorders and duplicate names", () => {
    expect(layerRenamesBetween(base, addLayer(base))).toEqual([]);
    expect(layerRenamesBetween(base, moveSortingLayer(base, 0, 1))).toEqual([]);
    expect(layerRenamesBetween(base, renameLayer(base, 1, "Default"))).toEqual([]);
    expect(layerRenamesBetween(base, renameLayer(base, 1, ""))).toEqual([]);
  });
});

describe("project-wide rename", () => {
  let fs: MemoryFileSystem;
  beforeEach(() => {
    fs = new MemoryFileSystem();
    const put = (path: string, v: unknown) => fs.files.set(joinPath(ROOT, path), JSON.stringify(v, null, 2));
    put("project.json", { name: "t", physics: { layers: ["Default", "Ground"] } });
    put("a.scene.json", scene({ id: "n", name: "N", components: [collider("Ground")] }));
    put("b.prefab.json", scene({ id: "m", name: "M", components: [collider("Ground")] }));
    put("c.scene.json", scene({ id: "o", name: "O", components: [collider("Default")] }));
  });

  it("rewrites other scenes and prefabs on disk, and the open scene as one undo step", async () => {
    const project = await openFolderProject(fs, ROOT);
    useProjectAssets(project);
    currentProject.value = project;
    Input.reset();
    const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    openSceneFile(engine, "a.scene.json");
    expect(layerUsers(project, "physics", "Ground").sort()).toEqual(["a.scene.json", "b.prefab.json"]);

    const done = await renameLayerReferences(project, [{ kind: "physics", from: "Ground", to: "Floor" }]);
    expect(done.sort()).toEqual(["a.scene.json (unsaved)", "b.prefab.json"]);
    expect(project.textOf("b.prefab.json")).toContain('"Floor"');
    expect(project.textOf("c.scene.json")).toContain('"Default"');
    const open = openScene.value!;
    expect(JSON.stringify(open.doc.toJSON())).toContain('"Floor"');
    expect(open.stack.undo()).toBe(true);
    expect(JSON.stringify(open.doc.toJSON())).toContain('"Ground"');
  });
});
