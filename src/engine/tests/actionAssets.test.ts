import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Input, InputPlayers, actionSetFromData, actionSetProblems, button, defineActions, defineActionsFromData } from "../index";
import { inputActionSets } from "../editor";

// ADR 0417: action sets as `*.actions.json` assets, listed in project.json, bound in `input/default.input.json`,
// read by name like code sets; an id both define is the asset's.

const DT = 1 / 60;
let engine: Engine | null = null;

afterEach(() => {
  Input.inject.releaseAll();
  engine?.dispose();
  engine = null;
  Assets.clearSources();
  vi.restoreAllMocks();
});

describe("actionSetProblems", () => {
  it("accepts a well-formed set", () => {
    expect(actionSetProblems({ id: "game.Ok", actions: [{ name: "jump", type: "button" }, { name: "move", type: "vec2", consume: true }], networked: true, redundancy: 3, encoding: { move: { quantize: 0.01 } } })).toEqual([]);
  });

  it("reports every problem at its path", () => {
    const fields = actionSetProblems({
      id: "NoDots",
      key: "bad key",
      actions: [{ name: "jump", type: "button", control: "<Keyboard>/space" }, { name: "jump", type: "stick" }, { name: "9x", type: "axis" }],
      redundancy: -1,
      encoding: { jump: { quantize: 0 }, ghost: {} },
      extra: 1,
    }).map((p) => p.field);
    expect(fields).toEqual(expect.arrayContaining(["extra", "id", "key", "redundancy", "actions.0.control", "actions.1.name", "actions.1.type", "actions.2.name", "encoding.jump", "encoding.jump.quantize", "encoding.ghost"]));
  });

  it("reports a value that isn't a set", () => {
    expect(actionSetProblems([])).toHaveLength(1);
    expect(actionSetProblems({ id: "game.X" })[0].field).toBe("actions");
  });
});

describe("defineActionsFromData", () => {
  it("registers the same kind of set as defineActions, with consume and networking options", () => {
    const def = defineActionsFromData({ id: "test.actionAssets.Plain", key: "plain", actions: [{ name: "fire", type: "button", consume: false }, { name: "aim", type: "vec3" }] });
    expect(def.key).toBe("plain");
    expect(def.actions.map((a) => [a.name, a.kind, a.valueFields])).toEqual([["fire", "button", ["fire"]], ["aim", "vec3", ["aim$x", "aim$y", "aim$z"]]]);
    expect(def.actions[0].type.options.consume).toBe(false);
    expect(def.actions[0].type.defaults).toEqual([]);
  });

  it("throws with the file's problems", () => {
    expect(() => defineActionsFromData({ id: "test.actionAssets.Bad", actions: [{ name: "x", type: "wheel" as never }] })).toThrow(/actions\.0\.type/);
  });

  it("is the asset's set when code defines the same id, whichever comes first", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    defineActions("test.actionAssets.Clash", { a: button() });
    const asset = defineActionsFromData({ id: "test.actionAssets.Clash", actions: [{ name: "b", type: "button" }] });
    expect(asset.actions.map((a) => a.name)).toEqual(["b"]);
    const code = defineActions("test.actionAssets.Clash", { c: button() });
    expect(code).toBe(asset);
    expect(warn).toHaveBeenCalledTimes(2);
    // The editor shows the clash on both entries (the Input dialog's list).
    expect(inputActionSets().find((s) => s.id === "test.actionAssets.Clash")).toMatchObject({ source: "asset", clash: true });
  });
});

describe("actionSetFromData", () => {
  it("defines a file once, and again when its text changes", () => {
    const first = actionSetFromData("input/once.actions.json", { id: "test.actionAssets.Once", actions: [{ name: "a", type: "button" }] });
    expect(actionSetFromData("input/once.actions.json", { id: "test.actionAssets.Once", actions: [{ name: "a", type: "button" }] })).toBe(first);
    const changed = actionSetFromData("input/once.actions.json", { id: "test.actionAssets.Once", actions: [{ name: "a", type: "axis" }] });
    expect(changed).not.toBe(first);
    expect(changed.actions[0].kind).toBe("axis");
  });

  it("names the file in its problems", () => {
    expect(() => actionSetFromData("input/broken.actions.json", { id: 3 })).toThrow(/input\/broken\.actions\.json/);
  });
});

describe("project boot (input.actionSets and the default context file)", () => {
  const files = {
    "input/player.actions.json": { id: "test.actionAssets.Player", actions: [{ name: "kick", type: "button" }, { name: "walk", type: "axis" }] },
    "input/default.input.json": {
      name: "default",
      mappings: [
        { action: "kick", control: "<Keyboard>/k" },
        { action: "walk", composite: "axis", negative: "<Keyboard>/j", positive: "<Keyboard>/l" },
      ],
    },
  };

  it("defines the listed sets before the first frame and binds them through input/default.input.json", async () => {
    engine = await Engine.create({ headless: true, assets: Assets.fromObject(files), project: { input: { actionSets: ["input/player.actions.json"] } } });
    engine.step(DT);
    Input.inject.keyDown("k");
    Input.inject.keyDown("l");
    engine.step(DT);
    const p0 = InputPlayers.get(0)!;
    expect(p0.performed("kick")).toBe(true);
    expect(p0.value("walk")).toBe(1);
  });

  it("warns about a listed file that's missing or broken, and boots anyway", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    engine = await Engine.create({
      headless: true,
      assets: Assets.fromObject({ "input/bad.actions.json": { id: "test.actionAssets.BadBoot", actions: "none" } }),
      project: { input: { actionSets: ["input/missing.actions.json", "input/bad.actions.json"] } },
    });
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("input/missing.actions.json"))).toBe(true);
    expect(lines.some((l) => l.includes("input/bad.actions.json") && l.includes("actions must be a list"))).toBe(true);
  });

  it("reports a list that isn't .actions.json files", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    engine = await Engine.create({ headless: true, project: { input: { actionSets: ["input/a.input.json", "input/a.input.json"] as string[] } } });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("Action set 1 must be a .actions.json file"))).toBe(true);
  });
});
