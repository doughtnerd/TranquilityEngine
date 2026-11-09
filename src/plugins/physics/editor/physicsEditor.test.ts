import { describe, expect, it } from "vitest";
import { componentNotes, projectSettingsSections } from "../../../editor/sdk/contributions";
import { isPluginActive } from "../../../editor/sdk";
import { useEditorPlugins } from "../../testEditorPlugins";
import { physicsEditorPlugin } from "./index";
import { backendOf, backendOptions, componentDimension, DEFAULT_BACKEND_LABEL, NO_BACKEND_NOTE, noBackendNote, setBackend } from "./physicsEditorModel";

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
    expect(componentDimension("engine.RigidBody2D")).toBe("2d");
    expect(componentDimension("engine.TilemapCollider2D")).toBe("2d");
    expect(componentDimension("engine.RigidBody")).toBe("3d");
    expect(componentDimension("engine.Buoyancy")).toBe("3d");
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
