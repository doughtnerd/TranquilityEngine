// The Input dialog's model (ADR 0433): the list's entries (asset and code sets, a clash shown on both), where each
// action is mapped, unmapped actions, type changes and renames carried into every context, scripts' defaults in
// `default`, and the nodes that turn a context on.
import { describe, expect, it } from "vitest";
import type { InputActionSetInfo } from "../engine/editor";
import type { ActionSetFile } from "../engine/input/actionAssets";
import type { InputContextSpec } from "../engine/input/contextTypes";
import {
  DEFAULT_CONTEXT_PATH,
  contextEntries,
  contextUsers,
  freeName,
  freeSetId,
  mapInDefault,
  mappedIn,
  renameInContexts,
  renameSetInContexts,
  retypeInContexts,
  scriptMappings,
  setEntries,
  setInfos,
  unmappedActions,
} from "./inputDialogModel";

const player: ActionSetFile = { id: "game.Player", actions: [{ name: "jump", type: "button" }, { name: "move", type: "axis" }, { name: "dash", type: "button" }] };
const engine: InputActionSetInfo[] = [
  { id: "engine.UIActions", source: "code", actions: [{ name: "submit", kind: "button", defaults: [{ action: "engine.UIActions:submit", control: "<Keyboard>/enter" }] }] },
  { id: "game.Player", source: "asset", actions: [{ name: "jump", kind: "button" }] },
  { id: "game.Code", source: "code", actions: [{ name: "jump", kind: "button" }] },
];
const def: InputContextSpec = { name: "default", mappings: [{ action: "game.Player:jump", control: "<Keyboard>/space" }, { action: "move", composite: "axis", negative: "<Keyboard>/a", positive: "<Keyboard>/d" }] };
const vehicle: InputContextSpec = { name: "vehicle", mappings: [{ action: "move", composite: "axis", negative: "<Keyboard>/left", positive: "<Keyboard>/right", triggers: [{ chord: { action: "game.Player:jump" } }] }] };
const contexts = contextEntries([
  { path: "input/vehicle.input.json", spec: vehicle },
  { path: DEFAULT_CONTEXT_PATH, spec: def },
]);

describe("the list's entries", () => {
  it("lists asset sets and the engine's other sets A to Z, code ones read-only", () => {
    const sets = setEntries([{ path: "input/player.actions.json", spec: player }], engine);
    expect(sets.map((s) => [s.id, s.source])).toEqual([
      ["engine.UIActions", "code"],
      ["game.Code", "code"],
      ["game.Player", "asset"],
    ]);
    expect(sets.find((s) => s.id === "game.Player")!.actions.map((a) => a.name)).toEqual(["jump", "move", "dash"]);
    expect(contexts.map((c) => [c.name, c.isDefault])).toEqual([
      ["default", true],
      ["vehicle", false],
    ]);
  });

  it("shows an id both a script and an asset define on both entries", () => {
    const clash = setEntries([{ path: "input/player.actions.json", spec: player }], [{ ...engine[1], clash: true }]);
    expect(clash.map((s) => [s.id, s.source, s.clash])).toEqual([
      ["game.Player", "asset", true],
      ["game.Player", "code", true],
    ]);
    // A code set beside a file that isn't loaded (not listed in input.actionSets) clashes too.
    const unloaded = setEntries([{ path: "input/code.actions.json", spec: { id: "game.Code", actions: [] } }], engine);
    expect(unloaded.filter((s) => s.id === "game.Code").map((s) => [s.source, s.clash])).toEqual([
      ["asset", true],
      ["code", true],
    ]);
    expect(setInfos(unloaded).filter((s) => s.id === "game.Code")).toHaveLength(1);
  });

  it("finds free names and ids", () => {
    expect(freeSetId(["game.New"])).toBe("game.New2");
    expect(freeName("vehicle", ["vehicle", "vehicle 2"])).toBe("vehicle 3");
  });
});

describe("where actions are mapped", () => {
  const sets = setInfos(setEntries([{ path: "input/player.actions.json", spec: player }], engine.slice(0, 1)));
  const scripts = scriptMappings(engine);

  it("lists each action's contexts with their controls, scripts' defaults included", () => {
    const mapped = mappedIn(contexts, sets, scripts);
    expect(mapped.get("game.Player:move")).toEqual([
      { path: DEFAULT_CONTEXT_PATH, context: "default", index: 1, controls: ["<Keyboard>/a", "<Keyboard>/d"] },
      { path: "input/vehicle.input.json", context: "vehicle", index: 0, controls: ["<Keyboard>/left", "<Keyboard>/right"] },
    ]);
    expect(mapped.get("engine.UIActions:submit")).toEqual([{ path: DEFAULT_CONTEXT_PATH, context: "default", index: -1, controls: ["<Keyboard>/enter"], fromScript: true }]);
    const player_ = setEntries([{ path: "input/player.actions.json", spec: player }], []).find((s) => s.id === "game.Player")!;
    expect(unmappedActions(player_, mapped)).toEqual(["dash"]);
  });

  it("maps an action in default with an empty control", () => {
    expect(mapInDefault(def, "dash").mappings.at(-1)).toEqual({ action: "dash", control: "" });
  });

  it("converts every mapping of an action whose type changes, saying what changed", () => {
    const changes = retypeInContexts(contexts, { set: "game.Player", name: "move" }, "axis", "vec2", sets);
    expect(changes.map((c) => c.path)).toEqual([DEFAULT_CONTEXT_PATH, "input/vehicle.input.json"]);
    expect(changes[1].spec.mappings[0]).toMatchObject({ action: "move", composite: "dpad", left: "<Keyboard>/left", right: "<Keyboard>/right", up: "", down: "" });
    expect(changes[1].spec.mappings[0].triggers).toEqual(vehicle.mappings[0].triggers); // the rest stays
    expect(changes[0].notes[0]).toMatch(/^default, mapping 2: Axis to D-pad/);
    expect(retypeInContexts(contexts, { set: "game.Player", name: "jump" }, "button", "axis", sets)).toEqual([]); // single controls stay
  });

  it("renames an action wherever a context names it, chords too", () => {
    const changes = renameInContexts(contexts, { set: "game.Player", name: "jump" }, "hop", sets);
    expect(changes.find((c) => c.path === DEFAULT_CONTEXT_PATH)!.spec.mappings[0].action).toBe("game.Player:hop");
    expect(changes.find((c) => c.path === "input/vehicle.input.json")!.spec.mappings[0].triggers).toEqual([{ chord: { action: "game.Player:hop" } }]);
  });

  it("renames a set's qualified references", () => {
    const changes = renameSetInContexts(contexts, "game.Player", "game.Hero");
    expect(changes.map((c) => c.path).sort()).toEqual([DEFAULT_CONTEXT_PATH, "input/vehicle.input.json"]);
    expect(changes.find((c) => c.path === DEFAULT_CONTEXT_PATH)!.spec.mappings.map((m) => m.action)).toEqual(["game.Hero:jump", "move"]);
  });
});

describe("a context's users", () => {
  it("lists the nodes whose InputContext names it, by path or name, highest priority first", () => {
    const vehicleEntry = contexts.find((c) => c.name === "vehicle")!;
    const users = contextUsers(vehicleEntry, [
      {
        path: "scenes/main.scene.json",
        nodes: [
          { id: "1", name: "Car", components: [{ type: "engine.InputContext", data: { context: "input/vehicle.input.json", priority: 10 } }] },
          { id: "2", name: "Truck", components: [{ type: "engine.InputContext", data: { context: "vehicle", priority: 20 } }] },
          { id: "3", name: "Menu", components: [{ type: "engine.InputContext", data: { context: "input/menu.input.json" } }] },
        ],
      },
      { path: "prefabs/bike.prefab.json", nodes: [{ id: "b", name: "Bike", components: [{ type: "engine.InputContext", data: { context: "input/vehicle.input.json" } }] }] },
    ]);
    expect(users.map((u) => [u.node, u.priority])).toEqual([
      ["Truck", 20],
      ["Bike", 10],
      ["Car", 10],
    ]);
  });
});
