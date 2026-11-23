// The graph's parameters through the SDK parameter list (ADR 0304; T51): add, rename and remove go through the list, with
// the graph's names and what a rename or remove carries along (conditions, node bindings, layer weights); type, default
// and flags are typed against what binds the parameter, refused-or-next.
import { describe, expect, it } from "vitest";
import { emptyAnimGraph, formatAnimGraph, parseAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { refusalOf, type EditResult } from "../../../../editor/sdk";
import { addLayer, addNode, setLayer, setNodeParam } from "./graphEditLogic";
import { addState, addTransition, setTransitionCondition, transitionsOf } from "./machineLogic";
import { graphParameters, parameterUses, setParameterDefault, setParameterFlag, setParameterType } from "./parameterLogic";

const ok = <T>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
function roundTrip(g: AnimGraph): void {
  const read = parseAnimGraph(JSON.parse(formatAnimGraph(g)));
  expect(read.problems).toEqual([]);
  expect(read.value).toEqual(g);
}

/** speed (float) drives a blend space's x, a layer's weight and a transition's condition. */
function used(): AnimGraph {
  let g = ok(graphParameters.add(emptyAnimGraph()));
  g = ok(graphParameters.rename(g, "Parameter", "speed"));
  g = ok(addNode(g, "sources", "blendSpace1D", [0, 0])).graph;
  g = ok(setNodeParam(g, "blendSpace1D", "x", "speed"));
  g = ok(addLayer(g, "blendSpace1D"));
  g = ok(setLayer(g, "Layer", { weightParameter: "speed" }));
  g = ok(addNode(g, "logic", "stateMachine", [0, 0])).graph;
  g = ok(addState(g, "stateMachine", [0, 0], "Idle")).graph;
  g = ok(addState(g, "stateMachine", [0, 0], "Move")).graph;
  g = ok(addTransition(g, "stateMachine", "Idle", "Move"));
  return ok(setTransitionCondition(g, "stateMachine", { from: "Idle", index: 0 }, { param: "speed", op: ">", value: 0.5 }));
}

describe("graph parameters (T51, ADR 0304)", () => {
  it("adds float parameters with valid graph names, up to the limit", () => {
    let g = ok(graphParameters.add(emptyAnimGraph()));
    g = ok(graphParameters.add(g));
    expect(g.parameters.map((p) => [p.name, p.type])).toEqual([["Parameter", "float"], ["Parameter2", "float"]]);
    roundTrip(g);
    let full = emptyAnimGraph();
    for (let i = 0; i < graphParameters.limit; i++) full = ok(graphParameters.add(full));
    expect(graphParameters.full(full)).toBe(true);
    expect(refusalOf(graphParameters.add(full))).toBe("at most 64 parameters");
  });

  it("renames through the graph: conditions, node bindings and layer weights; refuses taken and malformed names", () => {
    let g = used();
    expect(parameterUses(g, "speed")).toEqual({ conditions: 1, bindings: ["blendSpace1D.x"], layers: ["Layer"] });
    g = ok(graphParameters.add(g));
    expect(refusalOf(graphParameters.rename(g, "speed", "Parameter"))).toBe('another parameter is named "Parameter"');
    expect(refusalOf(graphParameters.rename(g, "speed", "move speed"))).toMatch(/letters, digits, _ and \./);
    g = ok(graphParameters.rename(g, "speed", "velocity"));
    expect(g.nodes[0]!.params.x).toBe("velocity");
    expect(g.layers[0]!.weightParameter).toBe("velocity");
    expect(transitionsOf(g.nodes[1]!.machine!, "Idle")[0]!.if).toEqual({ param: "velocity", op: ">", value: 0.5 });
    roundTrip(g);
  });

  it("refuses removing a parameter a condition compares; otherwise unbinds it", () => {
    let g = used();
    expect(refusalOf(graphParameters.remove(g, "speed"))).toBe("1 condition compares it; remove that row first");
    g = ok(setTransitionCondition(g, "stateMachine", { from: "Idle", index: 0 }, null));
    g = ok(graphParameters.remove(g, "speed"));
    expect(g.parameters).toEqual([]);
    expect(g.nodes[0]!.params.x).toBeUndefined();
    expect(g.layers[0]!.weightParameter).toBeNull();
    roundTrip(g);
  });

  it("changes type only where every binding takes it, resetting the default", () => {
    const g = used();
    expect(refusalOf(setParameterType(g, "speed", "bool"))).toMatch(/type mismatch: blendSpace1D.x/);
    let free = ok(graphParameters.add(emptyAnimGraph()));
    free = ok(setParameterType(free, "Parameter", "vec3"));
    expect(free.parameters[0]).toMatchObject({ type: "vec3", default: [0, 0, 0] });
    expect(refusalOf(setParameterDefault(free, "Parameter", 1))).toMatch(/type mismatch/);
    free = ok(setParameterDefault(free, "Parameter", [1, 2, 3]));
    free = ok(setParameterType(free, "Parameter", "int"));
    expect(refusalOf(setParameterDefault(free, "Parameter", 0.5))).toMatch(/whole number/);
    free = ok(setParameterDefault(free, "Parameter", 3));
    roundTrip(free);
  });

  it("predicts only replicated parameters", () => {
    let g = ok(graphParameters.add(emptyAnimGraph()));
    expect(refusalOf(setParameterFlag(g, "Parameter", "predicted", true))).toMatch(/replicate it first/);
    g = ok(setParameterFlag(g, "Parameter", "replicate", true));
    g = ok(setParameterFlag(g, "Parameter", "predicted", true));
    g = ok(setParameterFlag(g, "Parameter", "replicate", false));
    expect(g.parameters[0]).toMatchObject({ replicate: false, predicted: false });
    roundTrip(g);
  });
});
