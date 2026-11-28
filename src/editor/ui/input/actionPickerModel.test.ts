// The action picker's model (ADR 0433): sets and actions A to Z, folds (the engine's start folded), search across
// actions and set ids, the Create rows after the matches, and one highlight across every section.
import { describe, expect, it } from "vitest";
import { initialHighlight, moveHighlight, pickerModel, type PickerRow, type PickerSet } from "./actionPickerModel";

const sets: PickerSet[] = [
  { id: "game.VehicleActions", editable: true, actions: [{ name: "steer", kind: "axis" }, { name: "honk", kind: "button" }] },
  { id: "engine.UIActions", editable: false, actions: [{ name: "submit", kind: "button" }, { name: "navigate", kind: "vec2" }] },
  { id: "game.PlayerActions", editable: true, actions: [{ name: "jump", kind: "button" }, { name: "move", kind: "vec2" }] },
  { id: "game.MenuActions", editable: true, actions: [{ name: "adjust", kind: "axis" }] },
];
const none = new Map<string, boolean>();
const names = (rows: readonly PickerRow[]) => rows.map((r) => (r.kind === "action" ? `${r.set}:${r.name}` : r.kind === "create" ? `create:${r.set}:${r.name}` : `newSet:${r.name}`));

describe("the action picker", () => {
  it("lists sets by id and actions by name, the engine's sets folded", () => {
    const m = pickerModel(sets, "", none);
    expect(m.sections.map((s) => [s.id, s.folded, s.total])).toEqual([
      ["engine.UIActions", true, 2],
      ["game.MenuActions", false, 1],
      ["game.PlayerActions", false, 2],
      ["game.VehicleActions", false, 2],
    ]);
    expect(names(m.rows)).toEqual(["game.MenuActions:adjust", "game.PlayerActions:jump", "game.PlayerActions:move", "game.VehicleActions:honk", "game.VehicleActions:steer"]);
    expect(m.create).toEqual([]);
  });

  it("follows the folds the user chose", () => {
    const m = pickerModel(sets, "", new Map([["engine.UIActions", false], ["game.PlayerActions", true]]));
    expect(names(m.rows)).toEqual(["engine.UIActions:navigate", "engine.UIActions:submit", "game.MenuActions:adjust", "game.VehicleActions:honk", "game.VehicleActions:steer"]);
  });

  it("filters every set while searching, folded ones too, with the match marked, then offers Create in each set without it", () => {
    const m = pickerModel(sets, "ju", new Map([["game.PlayerActions", true]]));
    expect(m.sections.map((s) => [s.id, s.shown, s.total])).toEqual([
      ["game.MenuActions", 1, 1],
      ["game.PlayerActions", 1, 2],
    ]);
    expect(names(m.rows)).toEqual(["game.MenuActions:adjust", "game.PlayerActions:jump", "create:game.MenuActions:ju", "create:game.PlayerActions:ju", "create:game.VehicleActions:ju", "newSet:ju"]);
    const jump = m.rows[1] as Extract<PickerRow, { kind: "action" }>;
    expect(jump.label).toEqual({ pre: "", mid: "ju", post: "mp" });
  });

  it("doesn't offer Create in a set that has the name already, nor in the engine's", () => {
    const m = pickerModel(sets, "jump", none);
    expect(names(m.create)).toEqual(["create:game.MenuActions:jump", "create:game.VehicleActions:jump", "newSet:jump"]);
    expect(initialHighlight(m, null, "jump")).toBe(0); // the exact match
  });

  it("lists a whole set when its id matches", () => {
    expect(names(pickerModel(sets, "vehicle", none).rows).slice(0, 2)).toEqual(["game.VehicleActions:honk", "game.VehicleActions:steer"]);
  });

  it("says when nothing matches, and offers no Create for a name that can't be one", () => {
    const m = pickerModel(sets, "horn", none);
    expect(m.noMatch).toBe(true);
    expect(names(m.rows)).toEqual(["create:game.MenuActions:horn", "create:game.PlayerActions:horn", "create:game.VehicleActions:horn", "newSet:horn"]);
    const bad = pickerModel(sets, "no way", none);
    expect(bad.badName).toMatch(/letters/);
    expect(bad.create).toEqual([]);
  });

  it("starts on the current action and moves across sections, wrapping round", () => {
    const m = pickerModel(sets, "", none);
    const at = initialHighlight(m, { set: "game.PlayerActions", name: "move" }, "");
    expect(at).toBe(2);
    expect(moveHighlight(m, at, 1)).toBe(3); // into the next set
    expect(moveHighlight(m, 4, 1)).toBe(0);
    expect(moveHighlight(m, 0, -1)).toBe(4);
    expect(moveHighlight(pickerModel([], "", none), -1, 1)).toBe(-1);
  });
});
