import { afterEach, describe, expect, it, vi } from "vitest";
import { componentNotes, projectSettingsSections } from "../../../editor/sdk/contributions";
import { isPluginActive } from "../../../editor/sdk";
import { createProjectSettingsSection } from "../../../editor/projectSettingsSection";
import { closeTestProject, openTestProject } from "../../../editor/testing";
import { getComponentClass, getFields, listComponentIds } from "../../../engine/core/registry";
import { useEditorPlugins } from "../../testEditorPlugins";
import { physicsEditorPlugin } from "./index";
import { backendOf, backendOptions, noBackendNote, setBackend } from "./physicsEditorModel";
import { LAYERED_COMPONENTS, physicsLayers, renameLayer } from "./physicsSettingsModel";

const NO_BACKEND_NOTE = "(no physics backend)";
const DEFAULT_BACKEND_LABEL = "Default (only registered)";

describe("physics editor half", () => {
  const editorHalf = useEditorPlugins([physicsEditorPlugin], "each");

  it("registers its Project settings section after Time and the no-backend note, and removes them on deactivation", () => {
    expect(isPluginActive("myco.physics")).toBe(true);
    expect(projectSettingsSections.get("physics")).toMatchObject({ title: "Physics", after: "Time" });
    expect(componentNotes.get("physics.no-backend")).toBeDefined();
    editorHalf.off();
    expect(projectSettingsSections.get("physics")).toBeUndefined();
    expect(componentNotes.get("physics.no-backend")).toBeUndefined();
  });
});

describe("noBackendNote", () => {
  const state = (count2d: number, count3d: number, owner = "myco.physics") => ({ pluginOf: () => owner, backendCount: (d: "2d" | "3d") => (d === "2d" ? count2d : count3d) });
  it("finds a Component's dimension from the runtime's descriptions, and never notes Buoyancy (its kinematic mode needs no backend)", () => {
    const no2d = state(0, 1), no3d = state(1, 0);
    expect(noBackendNote("engine.RigidBody2D", no2d)).toBe(NO_BACKEND_NOTE);
    expect(noBackendNote("engine.ShapeCollider2D", no2d)).toBe(NO_BACKEND_NOTE);
    expect(noBackendNote("engine.RigidBody", no2d)).toBeNull();
    expect(noBackendNote("engine.MeshCollider", no3d)).toBe(NO_BACKEND_NOTE);
    expect(noBackendNote("engine.Buoyancy", no2d)).toBeNull();
    expect(noBackendNote("engine.Buoyancy", no3d)).toBeNull(); // the old /2D$/ rule called it 3D
    expect(noBackendNote("engine.Buoyancy", state(0, 0))).toBeNull();
  });
  it("labels only physics Components whose dimension has no backend", () => {
    expect(noBackendNote("engine.RigidBody2D", state(0, 1))).toBe(NO_BACKEND_NOTE);
    expect(noBackendNote("engine.RigidBody", state(1, 0))).toBe(NO_BACKEND_NOTE);
    expect(noBackendNote("engine.RigidBody2D", state(1, 0))).toBeNull();
    expect(noBackendNote("engine.RigidBody", state(0, 1))).toBeNull();
    expect(noBackendNote("engine.Camera", state(0, 0, "myco.sky"))).toBeNull();
  });
});

describe("backend dropdown model", () => {
  const rapier = [{ id: "rapier", title: "Rapier 2D" }];
  it("lists the default first, then the registered backends", () => {
    expect(backendOptions(rapier, undefined)).toEqual([{ value: "", label: DEFAULT_BACKEND_LABEL }, { value: "rapier", label: "Rapier 2D" }]);
  });
  it("keeps a named backend that isn't registered, marked", () => {
    expect(backendOptions(rapier, "box2d").at(-1)).toEqual({ value: "box2d", label: "box2d (not enabled)" });
    expect(backendOptions(rapier, "rapier")).toHaveLength(2);
  });
  it("writes physics.backend2d/backend3d and removes them for the default", () => {
    let d = setBackend({}, "2d", "rapier");
    expect(d.physics).toEqual({ backend2d: "rapier" });
    d = setBackend(d, "3d", "jolt");
    expect(backendOf(d, "3d")).toBe("jolt");
    d = setBackend(setBackend(d, "2d", ""), "3d", "");
    expect(d.physics).toBeUndefined();
    expect(backendOf(d, "2d")).toBe("");
  });
});

describe("the physics layers as a named list (ADR 0262)", () => {
  useEditorPlugins([physicsEditorPlugin]);
  afterEach(closeTestProject);

  it("is the Physics section's, and names every physics Component with a layer field", () => {
    expect(projectSettingsSections.get("physics")?.names).toEqual([physicsLayers]);
    const layered = listComponentIds().filter((id) => getFields(getComponentClass(id)!).some((f) => f.name === "layer"));
    expect([...LAYERED_COMPONENTS].sort()).toEqual(layered.filter((id) => id.startsWith("engine.")).sort());
    expect(LAYERED_COMPONENTS).toContain("engine.CharacterController2D"); // the old /Collider/ rule missed both controllers
  });

  it("renames colliders' and character controllers' layers through the settings section, not a script's own layer field", async () => {
    const component = (type: string) => ({ type, data: { layer: "Ground" } });
    const scene = { format: "myco.scene@1", nodes: [{ id: "n", name: "N", components: ["engine.BoxCollider2D", "engine.CharacterController", "game.Thing"].map(component) }] };
    const { project } = await openTestProject({ "project.json": JSON.stringify({ physics: { layers: ["Default", "Ground"] } }), "a.scene.json": JSON.stringify(scene) });
    const s = createProjectSettingsSection().open(project);
    await s.edit("Rename physics layer to Floor", renameLayer(s.draft, 1, "Floor"));
    await vi.waitFor(() => expect(project.textOf("a.scene.json")).toContain('"Floor"'));
    const layers = JSON.parse(project.textOf("a.scene.json")!).nodes[0].components.map((c: { data: { layer: string } }) => c.data.layer);
    expect(layers).toEqual(["Floor", "Floor", "Ground"]);
  });
});
