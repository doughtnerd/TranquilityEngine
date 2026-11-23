// The live parameter rows and edits (ADR 0373 "the parameter panel is live and editable"; T52), and which running
// Animator the graph editor debugs.
import { describe, expect, it } from "vitest";
import { GRAPH_PARAM_TYPES, parseAnimGraph } from "../../../../engine/animation/animGraph";
import { compileAnimGraph } from "../../../../engine/animation/graphCompile";
import type { AnimatorDebugFrame } from "../../runtime/features/debug/frame";
import { editValue, liveParameterRows, valueText } from "./liveParameterLogic";
import type { DebugTarget } from "./source";
import { debugStatus, pickTarget } from "./targetLogic";

const graph = parseAnimGraph({
  format: "myco.animgraph-source@1",
  output: "c",
  parameters: [
    { name: "speed", type: "float", default: 0.5 },
    { name: "grounded", type: "bool", default: true },
    { name: "aim", type: "vec2" },
    { name: "target", type: "node" },
    { name: "lean", type: "float", computed: true },
  ],
  nodes: [{ id: "c", family: "sources", kind: "clipPlayer", params: { clip: "asset:a.anim" } }],
}).value;
const tables = compileAnimGraph(graph);
const frame = (parameters: AnimatorDebugFrame["parameters"]): AnimatorDebugFrame => ({ index: 0, time: 0, report: { instance: 1, nodes: [], machines: [], transitions: [], requests: [], dropped: 0 }, parameters, inputs: [], root: [] });

describe("liveParameterRows", () => {
  it("shows what code set, else the graph's default; node parameters have no value", () => {
    const rows = liveParameterRows(graph, tables, frame([2.5, null, [0.1, 0.2], null, 0.3]));
    expect(rows.map((r) => [r.name, r.value, r.set, r.computed])).toEqual([
      ["speed", 2.5, true, false],
      ["grounded", true, false, false],
      ["aim", [0.1, 0.2], true, false],
      ["target", null, false, false],
      ["lean", 0.3, true, true],
    ]);
  });

  it("holds the defaults before the first frame", () => {
    expect(liveParameterRows(graph, tables, null).map((r) => r.value)).toEqual([0.5, true, [0, 0], null, 0]);
  });
});

describe("editValue", () => {
  // One case per parameter type.
  const cases: Record<(typeof GRAPH_PARAM_TYPES)[number], [ok: string | boolean | readonly number[], bad: string | boolean | readonly number[], why: string]> = {
    float: ["0.25", "fast", "type a number"],
    int: ["3", "2.5", "an int parameter takes a whole number"],
    bool: [true, "yes", "a bool parameter takes true or false"],
    vec2: [[1, 2], [1], "a vec2 parameter takes 2 numbers"],
    vec3: [[1, 2, 3], [1, Number.NaN, 3], "a vec3 parameter takes 3 numbers"],
    quat: [[0, 0, 0, 1], [0, 0, 1], "a quat parameter takes 4 numbers"],
    node: ["x", "y", "node parameters are set from code"],
  };
  for (const type of GRAPH_PARAM_TYPES) {
    it(`takes or refuses a ${type}`, () => {
      const [ok, bad, why] = cases[type];
      if (type === "node") expect(editValue(type, ok)).toEqual({ refused: why });
      else expect(editValue(type, ok)).toEqual({ value: typeof ok === "string" ? Number(ok) : ok });
      expect(editValue(type, bad)).toEqual({ refused: why });
    });
  }

  it("refuses an empty number", () => {
    expect(editValue("float", "  ")).toEqual({ refused: "type a number" });
  });
});

describe("valueText", () => {
  it("prints each kind of value", () => {
    expect([valueText(null), valueText(true), valueText(3), valueText(0.12345), valueText([0.1, 1])]).toEqual(["—", "true", "3", "0.123", "(0.10, 1.00)"]);
  });
});

describe("pickTarget", () => {
  const t = (id: string): DebugTarget => ({ id, label: id, graph: "a.animgraph.json", tables });
  const both = [t("A"), t("B")];
  it("prefers the picked Animator, then the selected one, then the only one", () => {
    expect(pickTarget(both, "B", "A")?.id).toBe("B");
    expect(pickTarget(both, "gone", "A")?.id).toBe("A");
    expect(pickTarget(both, null, "elsewhere")).toBeNull();
    expect(pickTarget([t("A")], null, null)?.id).toBe("A");
    expect(pickTarget([], "A", "A")).toBeNull();
  });

  it("says what the debugger is doing", () => {
    expect(debugStatus(false, [], null)).toBe("Play the game to debug this graph live.");
    expect(debugStatus(true, [], null)).toBe("No Animator in the running game uses this graph.");
    expect(debugStatus(true, both, null)).toBe("Select an Animator in the Hierarchy, or pick one here.");
    expect(debugStatus(true, both, both[0]!)).toBe("Debugging A");
  });
});
