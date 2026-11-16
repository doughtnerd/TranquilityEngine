import { describe, expect, it } from "vitest";
import { componentNotes, projectSettingsSections } from "../../../editor/sdk/contributions";
import { isPluginActive } from "../../../editor/sdk";
import { useEditorPlugins } from "../../testEditorPlugins";
import { physicsEditorPlugin } from "./index";
import { backendOf, backendOptions, noBackendNote, setBackend } from "./physicsEditorModel";

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
  it("finds a Component's dimension", () => {
    const no2d = state(0, 1); // ids ending in 2D are 2D, the rest 3D
    expect(noBackendNote("engine.RigidBody2D", no2d)).toBe(NO_BACKEND_NOTE);
    expect(noBackendNote("engine.TilemapCollider2D", no2d)).toBe(NO_BACKEND_NOTE);
    expect(noBackendNote("engine.RigidBody", no2d)).toBeNull();
    expect(noBackendNote("engine.Buoyancy", no2d)).toBeNull();
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
