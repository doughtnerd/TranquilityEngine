// Renaming and deactivating nodes inside prefab instances, and Open Prefab's mapping (ADR 0122).
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { OrbitCamera } from "./OrbitCamera";
import { AddNode, SetOverrides, type SceneFile } from "./document";
import { applyOverrides, findInner, innerBaseValue, instanceInnerNodes, isInnerPropertyOverridden, nodePropertyCommand, prefabTarget, revertInnerProperty } from "./prefabs";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { ancestorKeys, hierarchyEntries } from "./selectionModel";
import { currentProject, openScene, sceneCamera } from "./state";
import { MemoryFileSystem, ROOT, demoFolder } from "./testing";

let fs: MemoryFileSystem;
let project: EditorProject;

/** A prefab with a grandchild (frame → knob) and a nested pipe-pair instance that renames its top node. */
const DOOR: SceneFile = {
  format: "myco.scene@1",
  nodes: [
    { id: "door", name: "Door", components: [{ type: "engine.Transform" }] },
    { id: "frame", name: "Frame", parent: "door", components: [{ type: "engine.Transform" }] },
    { id: "knob", name: "Knob", parent: "frame", components: [{ type: "engine.Transform" }] },
    { id: "pp", parent: "door", prefab: "prefabs/pipe-pair.prefab.json", overrides: [{ target: ["top"], name: "Lid" }] },
  ],
};

const fileOf = (path: string) => JSON.parse(fs.files.get(joinPath(ROOT, path)) as string) as SceneFile;

beforeEach(async () => {
  Input.reset();
  fs = demoFolder();
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  await project.writeText("prefabs/door.prefab.json", JSON.stringify(DOOR));
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
  openScene.value!.stack.execute(new AddNode({ id: "d", prefab: "prefabs/door.prefab.json" }));
});

describe("inner node paths", () => {
  it("keys plain prefab nodes by instance and id at any depth, as the loader does", () => {
    const { doc, sync } = openScene.value!;
    const knob = findInner(doc, ["d", "knob"]);
    expect(knob?.name).toBe("Knob");
    expect(findInner(doc, ["d", "frame", "knob"])).toBeNull();
    expect(sync.nodeFor(["d", "knob"])?.name).toBe("Knob");
    expect(ancestorKeys(doc, "d/knob").slice(0, 2)).toEqual(["d/frame", "d"]);
  });

  it("shows a nested instance's own overrides and its prefab root's name", () => {
    const { doc, sync } = openScene.value!;
    expect(findInner(doc, ["d", "pp"])?.name).toBe(fileOf("prefabs/pipe-pair.prefab.json").nodes.find((n) => !n.parent)!.name);
    expect(findInner(doc, ["d", "pp", "top"])?.name).toBe("Lid");
    expect(sync.nodeFor(["d", "pp", "top"])?.name).toBe("Lid");
  });

  it("shows the nodes an instance adds and hides the ones it removes (ADR 0086)", () => {
    const { doc, stack } = openScene.value!;
    stack.execute(new SetOverrides("d", "edit", [{ target: ["knob"], removeNode: true }, { target: ["frame"], addNodes: [{ id: "bell", name: "Bell" }] }]));
    const keys = hierarchyEntries(doc).map((e) => e.key);
    expect(keys).toContain("d/bell");
    expect(keys).not.toContain("d/knob");
    expect(findInner(doc, ["d", "bell"])?.added).toBe(true);
    expect(ancestorKeys(doc, "d/bell")[0]).toBe("d/frame");
  });
});

describe("renaming and deactivating inside an instance", () => {
  it("renames an inner node as an override, and naming it back removes the override", () => {
    const { doc, stack, sync } = openScene.value!;
    stack.execute(nodePropertyCommand(doc, ["d", "knob"], "name", "Handle"));
    expect(doc.overrides("d")).toEqual([{ target: ["knob"], name: "Handle" }]);
    expect(sync.nodeFor(["d", "knob"])!.name).toBe("Handle");
    expect(findInner(doc, ["d", "knob"])!.name).toBe("Handle");
    expect(isInnerPropertyOverridden(doc, ["d", "knob"], "name")).toBe(true);

    stack.execute(nodePropertyCommand(doc, ["d", "knob"], "name", "Grip")); // replaces, doesn't add
    expect(doc.overrides("d")).toEqual([{ target: ["knob"], name: "Grip" }]);

    stack.execute(nodePropertyCommand(doc, ["d", "knob"], "name", "Knob"));
    expect(doc.overrides("d")).toEqual([]);
    expect(sync.nodeFor(["d", "knob"])!.name).toBe("Knob");

    stack.undo();
    expect(sync.nodeFor(["d", "knob"])!.name).toBe("Grip");
  });

  it("deactivates an inner node, and reverting brings it back", () => {
    const scene = openScene.value!;
    const { doc, stack, sync } = scene;
    stack.execute(nodePropertyCommand(doc, ["d", "frame"], "active", false));
    expect(doc.overrides("d")).toEqual([{ target: ["frame"], active: false }]);
    expect(sync.nodeFor(["d", "frame"])!.active).toBe(false);
    expect(findInner(doc, ["d", "frame"])!.active).toBe(false);
    expect(hierarchyEntries(doc).find((e) => e.key === "d/frame")).toBeTruthy();

    revertInnerProperty(scene, ["d", "frame"], "active");
    expect(doc.overrides("d")).toEqual([]);
    expect(sync.nodeFor(["d", "frame"])!.active).toBe(true);
  });

  it("compares with the nested instance's value: an outer rename wins over the prefab file's override", () => {
    const { doc, stack, sync } = openScene.value!;
    expect(innerBaseValue(doc, ["d", "pp", "top"], "name")).toBe("Lid");
    stack.execute(nodePropertyCommand(doc, ["d", "pp", "top"], "name", "Cap"));
    expect(doc.overrides("d")).toEqual([{ target: ["pp", "top"], name: "Cap" }]);
    expect(sync.nodeFor(["d", "pp", "top"])!.name).toBe("Cap");
    expect(findInner(doc, ["d", "pp", "top"])!.name).toBe("Cap");
    stack.execute(nodePropertyCommand(doc, ["d", "pp", "top"], "name", "Lid"));
    expect(doc.overrides("d")).toEqual([]);
  });

  it("renames the instance itself on its own entry, not as an override", () => {
    const { doc, stack } = openScene.value!;
    stack.execute(nodePropertyCommand(doc, ["d"], "name", "Front door"));
    expect(doc.node("d").name).toBe("Front door");
    expect(doc.overrides("d")).toEqual([]);
  });
});

describe("Apply writes names and active flags (ADR 0122)", () => {
  it("into plain prefab nodes, as overrides on nested instances, and leaves the instance root's alone", async () => {
    const scene = openScene.value!;
    const { doc, stack } = scene;
    stack.execute(nodePropertyCommand(doc, ["d", "knob"], "name", "Handle"));
    stack.execute(nodePropertyCommand(doc, ["d", "frame"], "active", false));
    stack.execute(nodePropertyCommand(doc, ["d", "pp", "top"], "name", "Cap"));
    stack.execute(nodePropertyCommand(doc, ["d", "pp"], "name", "Pipes"));
    // A hand-written override on the instance root stays on the instance.
    stack.execute(new SetOverrides("d", "root", [...doc.overrides("d"), { active: false }]));

    expect(await applyOverrides(scene, project, "d")).toBe(4);
    const door = fileOf("prefabs/door.prefab.json");
    const byId = (id: string) => door.nodes.find((n) => n.id === id)!;
    expect(byId("knob").name).toBe("Handle");
    expect(byId("frame").active).toBe(false);
    expect(byId("pp").name).toBe("Pipes");
    expect(byId("pp").overrides).toEqual([{ target: ["top"], name: "Lid" }, { target: ["top"], name: "Cap" }]);
    expect(byId("door").active).toBeUndefined();
    expect(doc.overrides("d")).toEqual([{ active: false }]);

    // The rebuilt instance shows the prefab's new values.
    expect(scene.sync.nodeFor(["d", "knob"])!.name).toBe("Handle");
    expect(instanceInnerNodes(doc, "d").find((n) => n.path[1] === "pp")!.children.find((c) => c.path[2] === "top")!.name).toBe("Cap");
  });

  it("activating a node the prefab has inactive writes active: true, and Apply removes the key", async () => {
    const scene = openScene.value!;
    await project.writeText("prefabs/door.prefab.json", JSON.stringify({ ...DOOR, nodes: DOOR.nodes.map((n) => (n.id === "frame" ? { ...n, active: false } : n)) }));
    scene.stack.execute(new SetOverrides("d", "refresh", []));
    scene.stack.execute(nodePropertyCommand(scene.doc, ["d", "frame"], "active", true));
    expect(scene.doc.overrides("d")).toEqual([{ target: ["frame"], active: true }]);
    await applyOverrides(scene, project, "d");
    expect(fileOf("prefabs/door.prefab.json").nodes.find((n) => n.id === "frame")!.active).toBeUndefined();
  });
});

describe("Open Prefab target (ADR 0122)", () => {
  it("maps an instance to its prefab's root and inner nodes to their path in the file", () => {
    const { doc, stack } = openScene.value!;
    expect(prefabTarget(doc, ["d"])).toEqual({ prefab: "prefabs/door.prefab.json", select: "door" });
    expect(prefabTarget(doc, ["d", "knob"])).toEqual({ prefab: "prefabs/door.prefab.json", select: "knob" });
    expect(prefabTarget(doc, ["d", "pp", "top"])).toEqual({ prefab: "prefabs/door.prefab.json", select: "pp/top" });
    stack.execute(new SetOverrides("d", "add", [{ addNodes: [{ id: "bell" }] }]));
    expect(prefabTarget(doc, ["d", "bell"])).toEqual({ prefab: "prefabs/door.prefab.json", select: null });
    const plain = doc.roots().find((id) => !doc.isPrefabInstance(id))!;
    expect(prefabTarget(doc, [plain])).toBeNull();
  });
});
