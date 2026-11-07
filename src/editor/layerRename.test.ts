import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { OrbitCamera } from "./OrbitCamera";
import { layerRenamesBetween, layerUsers, renameLayerReferences, withRenamedLayer } from "./layerRename";
import { openSceneFile } from "./project";
import { addLayer, renameLayer, renameSortingLayer, moveSortingLayer, type SettingsDraft } from "./projectSettingsModel";
import { editorSettings, joinPath, openFolderProject, useProjectAssets } from "./projects";
import { currentProject, openScene, sceneCamera } from "./state";
import { MemoryFileSystem, ROOT } from "./testing";

const scene = (data: unknown) => ({ format: "myco.scene@1", nodes: [data] });
const collider = (layer: string) => ({ type: "engine.BoxCollider2D", data: { layer } });

describe("withRenamedLayer (ADR 0116)", () => {
  it("renames collider layers and sprite sorting layers, each only for its own kind", () => {
    const json = scene({ id: "a", components: [collider("Ground"), { type: "engine.SpriteRenderer", data: { sortingLayer: "Ground" } }, { type: "game.Thing", data: { layer: "Ground" } }] });
    const phys = withRenamedLayer(json, "physics", "Ground", "Floor");
    expect(phys.count).toBe(1);
    expect(JSON.stringify(phys.value)).toContain('"layer":"Floor"');
    expect(JSON.stringify(phys.value)).toContain('"sortingLayer":"Ground"'); // untouched
    expect(JSON.stringify(phys.value)).toContain('{"type":"game.Thing","data":{"layer":"Ground"}}'); // not a collider
    const sort = withRenamedLayer(json, "sorting", "Ground", "Floor");
    expect(sort.count).toBe(1);
    expect(JSON.stringify(sort.value)).toContain('"sortingLayer":"Floor"');
  });

  it("renames prefab overrides and nested nodes, and reports no change by identity", () => {
    const json = scene({ id: "i", prefab: "p.prefab.json", children: [{ id: "c", components: [collider("A")] }], overrides: [{ target: ["x"], component: "engine.CircleCollider2D", field: "layer", value: "A" }, { target: ["x"], component: "game.Thing", field: "layer", value: "A" }] });
    const r = withRenamedLayer(json, "physics", "A", "B");
    expect(r.count).toBe(2);
    const text = JSON.stringify(r.value);
    expect(text).toContain('"value":"B"');
    expect(text.match(/"value":"A"/g)).toHaveLength(1);
    const none = withRenamedLayer(json, "physics", "Zed", "Q");
    expect(none.changed).toBe(false);
    expect(none.value).toBe(json);
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
