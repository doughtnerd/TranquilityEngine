// The input context editor's model (ADR 0336): the `*.input.json` format and the edits the editor makes, checked
// against the evaluator's own problems through the editor SDK.
import { describe, expect, it } from "vitest";
import { button, defineActions, dpad, vec2, type MappingSpec, type TriggerSpec } from "../engine";
import { canonicalControlPath, inputActionSets, inputContextProblems } from "../engine/editor";
import {
  CONTROL_GROUPS,
  actionChoices,
  actionRefFor,
  contextNotes,
  convertMapping,
  mappingControls,
  resolveActionRef,
  typeForControl,
  typeForMapping,
  unsuitedControls,
  formatInputContext,
  hasProjectActionSets,
  moveItem,
  newStep,
  parseInputContext,
  partValue,
  problemsByMapping,
  setComposite,
  setConsume,
  setPart,
  setStepParam,
  setTriggerType,
  stepParams,
  withSteps,
  controlSummary,
  groupTriggers,
  newTriggerIn,
  setNote,
  setTriggerGroup,
  triggerSummary,
  triggerType,
} from "./inputContextModel";

defineActions("test.inputContextModel.Player", { move: vec2(dpad("<Keyboard>/w", "<Keyboard>/s", "<Keyboard>/a", "<Keyboard>/d")), jump: button("<Keyboard>/space") });
defineActions("test.inputContextModel.Menu", { jump: button(), back: button() });

describe("the format", () => {
  it("reads a context file, keeping what it doesn't know, and writes it back as JSON", () => {
    const raw = { name: "onFoot", mappings: [{ action: "jump", control: "<Keyboard>/space", note: "kept" }], extra: 1 };
    const { value, problems } = parseInputContext(raw, "input/onFoot.input.json");
    expect(problems).toEqual([]);
    expect(value).toEqual(raw);
    expect(JSON.parse(formatInputContext(value))).toEqual(raw);
  });

  it("reports a file that isn't a context, and drops mappings that aren't objects", () => {
    expect(parseInputContext([1], "a.input.json").problems[0].message).toContain("isn't an input context");
    const { value, problems } = parseInputContext({ name: 3, mappings: [{ action: 5 }, "x"] }, "b.input.json");
    expect(value).toEqual({ name: "", mappings: [{ action: "" }] });
    expect(problems.map((p) => p.message)).toEqual(["1 of b.input.json's mappings aren't objects and were left out."]);
    expect(contextNotes(value)).toEqual(["The context has no name, so it goes by its file's path."]);
  });
});

describe("composites and parts", () => {
  it("turns a single control into a d-pad and a chord, keeping the main control where it still applies", () => {
    const single: MappingSpec = { action: "jump", control: "<Keyboard>/b", consume: false };
    const pad = setComposite(single, "dpad");
    expect(pad).toEqual({ action: "jump", consume: false, composite: "dpad", up: "", down: "", left: "", right: "" });
    const chord = setComposite(single, "modifier");
    expect(chord).toEqual({ action: "jump", consume: false, composite: "modifier", modifier: "", control: "<Keyboard>/b" });
    expect(setComposite(pad, "single")).toEqual({ action: "jump", consume: false, control: "" });
  });

  it("stores a chord's several modifiers as a list and shows them joined", () => {
    const m = setPart({ action: "dash", composite: "modifier", control: "<Keyboard>/b" }, "modifier", "<Keyboard>/shift + <Keyboard>/control");
    expect(m.modifier).toEqual(["<Keyboard>/shift", "<Keyboard>/control"]);
    expect(partValue(m, "modifier")).toBe("<Keyboard>/shift + <Keyboard>/control");
    expect(setPart(m, "modifier", "<Keyboard>/alt").modifier).toBe("<Keyboard>/alt");
  });
});

describe("modifiers and triggers", () => {
  it("makes steps with their default parameters", () => {
    expect(newStep("deadzone")).toEqual({ deadzone: { min: 0.15, max: 1 } });
    expect(newStep("hold")).toEqual({ hold: { min: 0.4 } });
    expect(newStep("pressed")).toEqual({ pressed: true });
    expect(newStep("multiTap")).toEqual({ multiTap: { count: 2, spacing: 0.3 } });
    expect(newStep("chord")).toEqual({ chord: { action: "" } });
    expect(newStep("combo", "jump")).toEqual({ combo: { steps: [{ action: "jump", within: 0.5 }] } });
  });

  it("writes per-component parameters as one value when x, y and z agree", () => {
    let negate = newStep("negate");
    expect(stepParams(negate)).toEqual({ y: true });
    negate = setStepParam(setStepParam(negate, "x", true), "z", true);
    expect(negate).toEqual({ negate: true });
    let scale = setStepParam(newStep("scale"), "x", 2);
    expect(scale).toEqual({ scale: { x: 2, y: 1, z: 1 } });
    scale = setStepParam(setStepParam(scale, "y", 2), "z", 2);
    expect(scale).toEqual({ scale: 2 });
  });

  it("removes an optional parameter, and keeps a trigger's type through edits", () => {
    let pulse = setTriggerType(setStepParam(newStep("pulse"), "limit", 3), "blocker");
    expect(pulse).toEqual({ pulse: { interval: 0.25, limit: 3 }, type: "blocker" });
    pulse = setStepParam(pulse, "limit", undefined);
    expect(pulse).toEqual({ pulse: { interval: 0.25 }, type: "blocker" });
    expect(setTriggerType(pulse, "")).toEqual({ pulse: { interval: 0.25 } });
  });

  it("drops empty step lists and an inherited consume, as hand-written files leave them out", () => {
    const m = withSteps({ action: "jump", control: "<Keyboard>/space", triggers: [{ pressed: true }] }, "triggers", []);
    expect(m).toEqual({ action: "jump", control: "<Keyboard>/space" });
    expect(setConsume(setConsume(m, "false"), "")).toEqual(m);
    expect(setConsume(m, "true").consume).toBe(true);
  });
});

describe("actions, controls and problems", () => {
  it("names an action bare unless another set has one of that name", () => {
    const choices = actionChoices(inputActionSets()).filter((c) => c.label.includes("test.inputContextModel"));
    expect(choices.map((c) => c.value)).toEqual(["move", "test.inputContextModel.Player:jump", "test.inputContextModel.Menu:jump", "back"]);
  });

  it("counts only the project's own action sets, not the engine's", () => {
    expect(hasProjectActionSets([{ id: "engine.UIActions", actions: [{ name: "navigate", kind: "vec2" }] }])).toBe(false);
    expect(hasProjectActionSets([])).toBe(false);
    expect(hasProjectActionSets(inputActionSets())).toBe(true);
  });

  it("offers controls by device, each one the evaluator accepts", () => {
    expect(CONTROL_GROUPS.map((g) => g.device)).toEqual(["Keyboard", "Pointer", "Gamepad", "Touch", "Pen"]);
    const all = CONTROL_GROUPS.flatMap((g) => g.controls);
    for (const path of ["<Gamepad>/touchpad1Position", "<Gamepad>/touchpadPress", "<Touch>/swipe", "<Touch>/touch9", "<Pen>/pressure", "<Pointer>/scroll"]) expect(all).toContain(path);
    for (const path of all) expect(canonicalControlPath(path)).toBe(path);
    const mappings = CONTROL_GROUPS.flatMap((g) => g.controls).map((control) => ({ action: "back", control }));
    expect(inputContextProblems({ name: "all", mappings })).toEqual([]);
  });

  it("lists the evaluator's problems under the mapping they're about", () => {
    const spec = {
      name: "x",
      mappings: [
        { action: "back", control: "<Gamepad>/buttonSouth" },
        { action: "back", composite: "dpad", up: "<Keyboard>/w" },
        { action: "back", control: "<Keyboard>/b", modifiers: [{ curve: { exponent: 0 } }] },
      ] as MappingSpec[],
    };
    const byMapping = problemsByMapping(inputContextProblems(spec));
    expect([...byMapping.keys()]).toEqual([1, 2]);
    expect(byMapping.get(1)![0]).toContain('"down" is missing');
    expect(byMapping.get(2)![0]).toContain("curve: exponent (0) must be above 0.");
  });

  it("moves a list item, clamped to the ends", () => {
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 2, -2)).toEqual([3, 1, 2]);
  });
});

// ADR 0417: the Input dialog's rules for action references, the type a control suggests, unsuited controls and how a
// type change converts a mapping.
describe("action references", () => {
  const sets = [
    { id: "game.A", actions: [{ name: "jump", kind: "button" as const }, { name: "move", kind: "vec2" as const }] },
    { id: "game.B", actions: [{ name: "jump", kind: "button" as const }] },
  ];
  it("resolves a bare name to the first set with it, and a qualified one to its set", () => {
    expect(resolveActionRef("move", sets)).toEqual({ set: "game.A", name: "move" });
    expect(resolveActionRef("jump", sets)).toEqual({ set: "game.A", name: "jump" });
    expect(resolveActionRef("game.B:jump", sets)).toEqual({ set: "game.B", name: "jump" });
    expect(resolveActionRef("game.B:move", sets)).toBeNull();
    expect(resolveActionRef("fly", sets)).toBeNull();
  });
  it("names an action bare unless another set shares the name", () => {
    expect(actionRefFor("game.A", "move", sets)).toBe("move");
    expect(actionRefFor("game.B", "jump", sets)).toBe("game.B:jump");
  });
});

describe("controls and action types", () => {
  it("suggests a type from a control: keys and buttons are buttons, a stick's X an axis, a stick a vec2, gyro a vec3", () => {
    expect(typeForControl("<Keyboard>/h")).toBe("button");
    expect(typeForControl("<Gamepad>/buttonSouth")).toBe("button");
    expect(typeForControl("<Gamepad>/leftStickX")).toBe("axis");
    expect(typeForControl("<Gamepad>/leftStick")).toBe("vec2");
    expect(typeForControl("<Pointer>/delta")).toBe("vec2");
    expect(typeForControl("<Gamepad>/gyro")).toBe("vec3");
    expect(typeForControl("")).toBe("button");
    expect(typeForMapping({ action: "", composite: "dpad", up: "", down: "", left: "", right: "" })).toBe("vec2");
    expect(typeForMapping({ action: "", composite: "axis", negative: "", positive: "" })).toBe("axis");
    expect(typeForMapping({ action: "", composite: "modifier", modifier: "<Keyboard>/shift", control: "<Keyboard>/b" })).toBe("button");
  });

  it("warns when a control doesn't suit the action's type", () => {
    expect(unsuitedControls({ action: "move", control: "<Keyboard>/w" }, "vec2")[0]).toMatch(/only X/);
    expect(unsuitedControls({ action: "move", control: "<Gamepad>/leftStick" }, "vec2")).toEqual([]);
    expect(unsuitedControls({ action: "jump", control: "<Gamepad>/leftStick" }, "button")[0]).toMatch(/2 axes/);
    expect(unsuitedControls({ action: "jump", control: "<Gamepad>/leftStickX" }, "button")).toEqual([]); // past the press point
    expect(unsuitedControls({ action: "steer", composite: "dpad", up: "", down: "", left: "", right: "" }, "axis")[0]).toMatch(/Axis \(two buttons\)/);
    expect(unsuitedControls({ action: "move", composite: "axis", negative: "", positive: "" }, "vec2")[0]).toMatch(/only X/);
    expect(unsuitedControls({ action: "look", control: "<Gamepad>/leftStick" }, "vec3")).toEqual([]);
  });

  it("converts a mapping for a new type, keeping what still means something", () => {
    const dpadMove: MappingSpec = { action: "move", composite: "dpad", up: "<Keyboard>/w", down: "<Keyboard>/s", left: "<Keyboard>/a", right: "<Keyboard>/d", consume: false };
    const toAxis = convertMapping(dpadMove, "vec2", "axis");
    expect(toAxis.mapping).toEqual({ action: "move", composite: "axis", negative: "<Keyboard>/a", positive: "<Keyboard>/d", consume: false });
    expect(toAxis.note).toMatch(/dropped up \(<Keyboard>\/w\), down \(<Keyboard>\/s\)/);
    const toButton = convertMapping(dpadMove, "vec2", "button");
    expect(toButton.mapping).toEqual({ action: "move", control: "<Keyboard>/w", consume: false });
    const axis: MappingSpec = { action: "steer", composite: "axis", negative: "<Keyboard>/a", positive: "<Keyboard>/d" };
    expect(convertMapping(axis, "axis", "button").mapping).toEqual({ action: "steer", control: "<Keyboard>/d" });
    expect(convertMapping(axis, "axis", "vec2").mapping).toEqual({ action: "steer", composite: "dpad", up: "", down: "", left: "<Keyboard>/a", right: "<Keyboard>/d" });
    const single: MappingSpec = { action: "jump", control: "<Gamepad>/leftStick" };
    expect(convertMapping(single, "vec2", "button")).toEqual({ mapping: single, note: null });
    expect(mappingControls(toAxis.mapping)).toEqual(["<Keyboard>/a", "<Keyboard>/d"]);
  });
});

describe("triggers grouped by how they combine (ADR 0417)", () => {
  const triggers: TriggerSpec[] = [{ hold: { min: 0.4 } }, { chord: { action: "sprint" } }, { tap: { max: 0.2 }, type: "blocker" }, { pressed: true, type: "implicit" }];

  it("puts each trigger in its type's group, a chord in All of these when it gives no type", () => {
    const groups = groupTriggers(triggers);
    expect(groups.map((g) => g.label)).toEqual(["Any of these", "All of these", "Blocked by"]);
    expect(groups.map((g) => g.items.map((i) => i.index))).toEqual([[0], [1, 3], [2]]);
    expect(groupTriggers([]).every((g) => g.items.length === 0)).toBe(true);
    expect(triggerType({ chord: { action: "a" }, type: "explicit" })).toBe("explicit");
  });

  it("changes a trigger's group, writing no type when the group is its kind's default", () => {
    expect(setTriggerGroup({ hold: { min: 0.4 } }, "blocker")).toEqual({ hold: { min: 0.4 }, type: "blocker" });
    expect(setTriggerGroup({ hold: { min: 0.4 }, type: "blocker" }, "explicit")).toEqual({ hold: { min: 0.4 } });
    expect(setTriggerGroup({ chord: { action: "a" } }, "explicit")).toEqual({ chord: { action: "a" }, type: "explicit" });
    expect(setTriggerGroup({ chord: { action: "a" }, type: "explicit" }, "implicit")).toEqual({ chord: { action: "a" } });
  });

  it("adds a trigger into a group with its default parameters, and the evaluator accepts what's written", () => {
    expect(newTriggerIn("tap", "implicit")).toEqual({ tap: { max: 0.2 }, type: "implicit" });
    expect(newTriggerIn("chord", "implicit", "fire")).toEqual({ chord: { action: "fire" } });
    expect(newTriggerIn("down", "explicit")).toEqual({ down: true });
    const m: MappingSpec = { action: "back", control: "<Keyboard>/f", triggers: [newTriggerIn("hold", "blocker"), newTriggerIn("tap", "implicit")] };
    expect(inputContextProblems({ name: "t", mappings: [m] })).toEqual([]);
  });

  it("says each trigger on its chip", () => {
    expect(triggers.map(triggerSummary)).toEqual(["hold 0.4s", "chord sprint", "tap 0.2s", "pressed"]);
    expect(triggerSummary({ combo: { steps: [{ action: "a" }, { action: "b" }] } })).toBe("combo a → b");
    expect(triggerSummary({ multiTap: { count: 3, spacing: 0.3 } })).toBe("3× tap");
  });
});

describe("a mapping's note and summary (ADR 0417)", () => {
  it("writes a note, and drops an empty one", () => {
    const m: MappingSpec = { action: "jump", control: "<Keyboard>/space" };
    expect(setNote(m, "  Space is jump everywhere ")).toEqual({ ...m, note: "Space is jump everywhere" });
    expect(setNote({ ...m, note: "x" }, " ")).toEqual(m);
    // A context with notes reads back the same and the evaluator doesn't flag them.
    const spec = { name: "n", mappings: [setNote(m, "why")] };
    expect(parseInputContext(JSON.parse(formatInputContext(spec)), "n.input.json").value).toEqual(spec);
  });

  it("says a mapping's controls in one line", () => {
    expect(controlSummary({ action: "a", control: "<Keyboard>/space" })).toBe("space");
    expect(controlSummary({ action: "a", control: "<Gamepad>/leftStick" })).toBe("Gamepad leftStick");
    expect(controlSummary({ action: "a", composite: "dpad", up: "<Keyboard>/w", down: "<Keyboard>/s", left: "<Keyboard>/a", right: "" })).toBe("D-pad w s a —");
    expect(controlSummary({ action: "a", composite: "axis", negative: "<Keyboard>/a", positive: "<Keyboard>/d" })).toBe("Axis a / d");
    expect(controlSummary({ action: "a", composite: "modifier", modifier: ["<Keyboard>/shift", "<Keyboard>/control"], control: "<Keyboard>/b" })).toBe("shift + control + b");
    expect(controlSummary({ action: "a" })).toBe("no control");
  });
});
