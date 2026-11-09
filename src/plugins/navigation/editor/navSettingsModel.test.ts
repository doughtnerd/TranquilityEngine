import { describe, expect, it } from "vitest";
import { DEFAULT_NAV_AGENT_TYPE_ID } from "../../../engine/nav/settings";
import {
  addNavAgentType,
  addNavArea,
  addNavAvoidanceLayer,
  navAgentLayer,
  navAgentTypeWarnings,
  navAvoidanceLayerUsers,
  navAvoidanceMatrix,
  navAvoidanceSummary,
  navListedLayers,
  navObstacleSummary,
  navVoxelWarning,
  nextFreeNavAvoidanceLayer,
  renameNavAvoidanceLayer,
  setNavAgentLayer,
  setNavAvoidanceCell,
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
import { readDraft, sectionsKey, settingsProblems, withSettings, type SettingsDraft } from "../../../editor/projectSettingsModel";
import { useEditorPlugins } from "../../testEditorPlugins";
import { navigationEditorPlugin } from "./index";

// The Project panel's Navigation section (ADR 0065): editing project.json's `navigation` key, which the
// section owns and checks (ADR 0151) while the plugin is on.
useEditorPlugins([navigationEditorPlugin]);

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

// ADR 0066: Foxfire's named avoidance layers, who-avoids-whom matrix, summaries and per-type warnings.
describe("avoidance layers", () => {
  const EVERYTHING = 0xffffffff;
  /** Player (layer 1), Grunt and Brute (layer 2, Enemy), a flyer and a type with avoidance off. */
  function draft(): SettingsDraft {
    const type = (id: string, name: string, layers: number, avoidLayers: number, extra: object = {}) => ({ id, name, avoidance: { layers, avoidLayers }, ...extra });
    return {
      navigation: {
        avoidanceLayers: ["Default", "Player", "Enemy"],
        agentTypes: [
          type("p", "Player", 2, 4),
          type("g", "Grunt", 4, EVERYTHING),
          type("b", "Brute", 4, 2),
          type("f", "Bird", 2, EVERYTHING, { canWalk: false, canFly: true }),
          { id: "o", name: "Off", avoidance: null },
        ],
      },
    };
  }

  it("names the next free slot, renames and clears (trailing unnamed slots dropped)", () => {
    let d = addNavAvoidanceLayer(draft());
    expect(navigationOf(d).avoidanceLayers).toEqual(["Default", "Player", "Enemy", "Layer 3"]);
    d = renameNavAvoidanceLayer(d, 3, "Boss");
    expect(navigationOf(d).avoidanceLayers[3]).toBe("Boss");
    d = renameNavAvoidanceLayer(d, 1, "");
    expect(nextFreeNavAvoidanceLayer(navigationOf(d))).toBe(1);
    d = renameNavAvoidanceLayer(d, 3, "");
    expect(navigationOf(d).avoidanceLayers).toEqual(["Default", "", "Enemy"]);
    expect(navAvoidanceLayerUsers(navigationOf(d), 1)).toEqual(["Player", "Bird"]);
    // Listed: layer 0, the named ones, and layer 1 (in use though unnamed).
    expect(navListedLayers(navigationOf(d))).toEqual([0, 1, 2]);
    d = renameNavAvoidanceLayer(d, 9, "Far");
    expect(navigationOf(d).avoidanceLayers).toHaveLength(10);
    expect(settingsProblems(d)).toEqual([]);
  });

  it("puts a type on one layer", () => {
    let d = setNavAgentLayer(draft(), 0, 5);
    expect(navigationOf(d).agentTypes[0].avoidance!.layers).toBe(32);
    expect(navAgentLayer(navigationOf(d).agentTypes[0])).toBe(5);
    d = setNavAgentLayer(d, 0, null);
    expect(navigationOf(d).agentTypes[0].avoidance!.layers).toBe(0);
    expect(navAgentLayer(navigationOf(d).agentTypes[0])).toBeNull();
  });

  it("builds the matrix: rows are layers avoiding types are on, ticked / mixed / clear, not symmetric", () => {
    const m = navAvoidanceMatrix(navigationOf(draft()));
    expect(m.columns).toEqual([0, 1, 2]);
    // The flyer and the type with avoidance off take no part; nothing is on Default, so it has no row.
    expect(m.rows.map((r) => [r.layer, r.label])).toEqual([
      [1, "Player (Player)"],
      [2, "Enemy (Brute, Grunt)"],
    ]);
    const state = (row: number, col: number) => m.rows.find((r) => r.layer === row)!.cells.find((c) => c.layer === col)!;
    expect(state(1, 2).state).toBe("on"); // the player avoids enemies
    expect(state(1, 1).state).toBe("off"); // ...but not players
    expect(state(2, 1).state).toBe("on"); // Grunt avoids everything, Brute avoids Player
    expect(state(2, 2).state).toBe("mixed"); // only Grunt avoids enemies
    expect(state(2, 2).tip).toBe("Enemy avoids Enemy: only Grunt");
    expect(state(2, 0).tip).toBe("Enemy avoids Default: only Grunt");
    expect(state(1, 0).state).toBe("off");
  });

  it("a click sets or clears the column's bit for every type on the row, in one edit", () => {
    let d = setNavAvoidanceCell(draft(), 2, 2, true);
    let types = navigationOf(d).agentTypes;
    expect(types.find((t) => t.id === "g")!.avoidance!.avoidLayers).toBe(EVERYTHING);
    expect(types.find((t) => t.id === "b")!.avoidance!.avoidLayers).toBe(6);
    expect(types.find((t) => t.id === "p")!.avoidance!.avoidLayers).toBe(4); // other rows untouched
    expect(navAvoidanceMatrix(navigationOf(d)).rows[1].cells[2].state).toBe("on");
    d = setNavAvoidanceCell(d, 2, 1, false);
    types = navigationOf(d).agentTypes;
    expect(types.find((t) => t.id === "g")!.avoidance!.avoidLayers).toBe(EVERYTHING - 2); // stays unsigned
    expect(types.find((t) => t.id === "b")!.avoidance!.avoidLayers).toBe(4);
    expect(types.find((t) => t.id === "f")!.avoidance!.avoidLayers).toBe(EVERYTHING); // flyers take no part
    // Ticking every bit gives Everything back.
    d = setNavAvoidanceCell(d, 2, 1, true);
    expect(navigationOf(d).agentTypes.find((t) => t.id === "g")!.avoidance!.avoidLayers).toBe(EVERYTHING);
    expect(setNavAvoidanceCell(draft(), 0, 1, true)).toEqual(draft()); // no row on Default
    expect(settingsProblems(d)).toEqual([]);
  });

  it("summarises like Foxfire's NavAvoidanceSummary", () => {
    const nav = navigationOf(draft());
    const by = (id: string) => nav.agentTypes.find((t) => t.id === id)!;
    expect(navAvoidanceSummary(nav, by("p"))).toEqual(["On: Player", "Avoids: Enemy", "Avoided by: Brute, Grunt"]);
    expect(navAvoidanceSummary(nav, by("g"))).toEqual(["On: Enemy", "Avoids: Everything", "Avoided by: Grunt, Player"]);
    expect(navAvoidanceSummary(nav, by("o"))[0]).toMatch(/^Avoidance is off/);
    expect(navAvoidanceSummary(nav, by("f"))[0]).toMatch(/only flies/);
    expect(navAvoidanceSummary(nav, by("f"))[1]).toBe("It separates from flyers on: Everything (it's on: Player).");
    expect(navObstacleSummary(nav, 4)).toEqual(["On: Enemy", "Avoided by: Grunt, Player"]);
    expect(navObstacleSummary(nav, 1)).toEqual(["On: Default", "Avoided by: Grunt"]);
  });

  it("warns per agent type like Foxfire's NavigationSetup inspector", () => {
    const nav = navigationOf({});
    const t = nav.agentTypes[0]; // 0.25 x 0.125 m voxels, 0.4 m steps: holds ~56 degree slopes, coverage 55
    expect(navAgentTypeWarnings(nav, t)).toEqual([]);
    expect(navVoxelWarning({ ...nav, orientation: { ...nav.orientation, coverageDeg: 60 } }, t)).toMatch(/more than ~56 degrees.*Step Height 0.4 over Cell Size 0.25.*up to 60 degrees/);
    expect(navVoxelWarning({ ...nav, voxels: "fixed", cellSize: 0.25, cellHeight: 0.5 }, t)).toMatch(/^Step Height \(0.4\) is below Cell Height \(0.5\)/);
    const neither = { ...t, canWalk: false, canFly: false };
    expect(navAgentTypeWarnings(nav, neither)).toEqual(["Humanoid can neither walk nor fly: nothing is baked for it."]);
  });
});
