import { describe, expect, it } from "vitest";
import { DEFAULT_NAV_AGENT_TYPE_ID } from "../engine/nav/settings";
import {
  addNavAgentType,
  addNavArea,
  navAreaCostOf,
  navColorHex,
  navHexColor,
  navigationOf,
  navigationProblems,
  navVoxelSize,
  removeNavAgentType,
  removeNavArea,
  renameNavAgentType,
  resetNavigation,
  setNavAgentAreaCost,
  setNavAgentAvoidance,
  setNavAgentValue,
  setNavAreaValue,
  setNavValue,
} from "./navSettingsModel";
import { readDraft, sectionsKey, settingsProblems, withSettings, type SettingsDraft } from "./projectSettingsModel";

// The Project panel's Navigation section (ADR 0065): editing project.json's `navigation` key.

describe("navigation settings draft", () => {
  it("reads the defaults without a section, and writes only the navigation key", () => {
    const settings = { name: "Game" };
    const draft = readDraft(settings);
    expect(navigationOf(draft).agentTypes.map((t) => t.id)).toEqual([DEFAULT_NAV_AGENT_TYPE_ID]);
    const next = addNavAgentType(draft, "id-2");
    const text = withSettings('{\n  "name": "Game"\n}\n', next, settings);
    const json = JSON.parse(text);
    expect(json.name).toBe("Game");
    expect(json.navigation.agentTypes.map((t: { id: string; name: string }) => [t.id, t.name])).toEqual([
      [DEFAULT_NAV_AGENT_TYPE_ID, "Humanoid"],
      ["id-2", "Agent"],
    ]);
    expect(sectionsKey(next)).not.toBe(sectionsKey(draft));
    expect(settingsProblems(next)).toEqual([]);
  });

  it("adds agent types with fresh UUIDs and unique names, keeps at least one, and renames", () => {
    let d: SettingsDraft = {};
    d = addNavAgentType(addNavAgentType(d));
    const types = navigationOf(d).agentTypes;
    expect(types.map((t) => t.name)).toEqual(["Humanoid", "Agent", "Agent 2"]);
    expect(types[1].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(types[1].id).not.toBe(types[2].id);
    d = renameNavAgentType(d, 1, "Dog");
    expect(renameNavAgentType(d, 1, " ")).toBe(d);
    d = removeNavAgentType(removeNavAgentType(d, 0), 0);
    expect(navigationOf(d).agentTypes.map((t) => t.name)).toEqual(["Agent 2"]);
    expect(removeNavAgentType(d, 0)).toBe(d);
  });

  it("sets agent values by path, and a bad one is a problem until fixed or undone", () => {
    let d = setNavAgentValue({}, 0, "walk.radius", 0.3);
    expect(navigationOf(d).agentTypes[0].walk.radius).toBe(0.3);
    d = setNavAgentValue(d, 0, "canFly", true);
    d = setNavAgentValue(d, 0, "flight.speed", 8);
    expect(navigationOf(d).agentTypes[0]).toMatchObject({ canFly: true, flight: { speed: 8 } });
    const bad = setNavAgentValue(d, 0, "walk.radius", -1);
    const problems = settingsProblems(bad);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ field: "navigation" });
    expect(problems[0].message).toMatch(/walk\.radius should be at least/);
    expect(navigationProblems(d)).toEqual([]);
    d = setNavAgentAvoidance(d, 0, false);
    expect(navigationOf(d).agentTypes[0].avoidance).toBeNull();
    d = setNavAgentAvoidance(d, 0, true);
    expect(navigationOf(d).agentTypes[0].avoidance?.maxNeighbors).toBe(10);
  });

  it("edits areas and agent types' cost overrides; removing an area drops its overrides", () => {
    let d = addNavArea(addNavArea({}, "mud"), "water");
    expect(navigationOf(d).areas.map((a) => a.name)).toEqual(["Area", "Area 2"]);
    d = setNavAreaValue(d, 0, "name", "Mud");
    d = setNavAreaValue(d, 0, "cost", 3);
    d = setNavAreaValue(d, 1, "color", navHexColor("#00ff80"));
    expect(navColorHex(navigationOf(d).areas[1].color)).toBe("#00ff80");
    d = setNavAgentAreaCost(d, 0, "mud", 5);
    d = setNavAgentAreaCost(d, 0, "water", "excluded");
    const t = navigationOf(d).agentTypes[0];
    expect(navAreaCostOf(t, "mud")).toBe(5);
    expect(navAreaCostOf(t, "water")).toBe("excluded");
    expect(navAreaCostOf(navigationOf(setNavAgentAreaCost(d, 0, "mud", null)).agentTypes[0], "mud")).toBeNull();
    d = removeNavArea(d, 0);
    expect(navigationOf(d).areas.map((a) => a.id)).toEqual(["water"]);
    expect(navigationOf(d).agentTypes[0].areaCosts.map((c) => c.area)).toEqual(["water"]);
    expect(settingsProblems(d)).toEqual([]);
  });

  it("sets advanced values by path, validates them, and resets to the defaults", () => {
    let d = setNavValue({}, "build.vertsPerPoly", 5);
    d = setNavValue(d, "voxels", "fixed");
    expect(navigationOf(d)).toMatchObject({ voxels: "fixed", build: { vertsPerPoly: 5 } });
    expect(settingsProblems(setNavValue(d, "tileSize", 8))[0].message).toMatch(/tileSize should be at least 16/);
    expect(resetNavigation(d).navigation).toBeUndefined();
  });

  it("previews the voxel size an agent type bakes with", () => {
    const nav = navigationOf({});
    const t = nav.agentTypes[0]; // radius 0.5, step 0.4, height 2; 2 cells per radius
    expect(navVoxelSize(nav, t)).toEqual({ cellSize: 0.25, cellHeight: 0.125, radiusCells: 2, stepCells: 3, heightCells: 16 });
    const fixed = { ...nav, voxels: "fixed" as const, cellSize: 0.1, cellHeight: 0.05 };
    expect(navVoxelSize(fixed, t)).toMatchObject({ cellSize: 0.1, cellHeight: 0.05, radiusCells: 5 });
  });
});
