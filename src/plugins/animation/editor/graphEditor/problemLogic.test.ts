// The compiler's problems on the graph (T51 over T30's paths): each problem the compiler reports for a graph shows on
// the node, field, state, transition, parameter or layer its path names.
import { describe, expect, it } from "vitest";
import { emptyAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { compileAnimGraph } from "../../../../engine/animation/graphCompile";
import { indexProblems, problemPlace, transitionKey, worst } from "./problemLogic";

const graph: AnimGraph = {
  ...emptyAnimGraph(),
  parameters: [{ name: "speed", type: "float", default: 0, replicate: false, predicted: false, computed: false }],
  output: "loco",
  nodes: [
    { id: "walk", family: "sources", kind: "clipPlayer", name: "", inputs: [], params: { clip: "asset:clips/walk.anim.json" } },
    { id: "move", family: "sources", kind: "blendSpace1D", name: "", inputs: ["walk"], params: { x: "speed", coords: [0, 1, 2] } },
    {
      id: "loco", family: "logic", kind: "stateMachine", name: "", inputs: [], params: {},
      machine: {
        entry: "Idle",
        anyState: [],
        states: [
          { name: "Idle", root: "walk", exit: false, transitions: [{ id: "", to: "Move", if: null, when: "now", how: "crossfade", duration: 0.2, shape: "linear", bridge: null, interrupt: "never" }] },
          { name: "Move", root: "move", exit: false, transitions: [] },
          { name: "Lost", root: null, exit: false, transitions: [] },
        ],
      },
    },
  ],
  layers: [],
};

describe("compile problems on the graph (T51)", () => {
  it("places paths on nodes, fields, states, transitions, parameters, layers and the output", () => {
    expect(problemPlace(graph, "nodes[1].params.coords")).toEqual({ node: "move", field: "coords" });
    expect(problemPlace(graph, "nodes[1].params.coords[3]")).toEqual({ node: "move", field: "coords" });
    expect(problemPlace(graph, "nodes[1].inputs[0]")).toEqual({ node: "move", part: "inputs" });
    expect(problemPlace(graph, "nodes[2].machine.states[2]")).toEqual({ node: "loco", part: "machine", state: "Lost" });
    expect(problemPlace(graph, "nodes[2].machine.states[0].transitions[0].if.any[1]")).toEqual({ node: "loco", part: "machine", state: "Idle", transition: { from: "Idle", index: 0 } });
    expect(problemPlace(graph, "nodes[2].machine.anyState[1]")).toEqual({ node: "loco", part: "machine", transition: { from: null, index: 1 } });
    expect(problemPlace(graph, "parameters[0].default")).toEqual({ parameter: "speed" });
    expect(problemPlace(graph, "output")).toEqual({ output: true });
    expect(problemPlace(graph, "nodes[9].params.x")).toEqual({});
  });

  it("indexes what the compiler reports: a blend space's coordinates on its field, an unreachable state on the state", () => {
    const problems = compileAnimGraph(graph).problems;
    const index = indexProblems(graph, problems);
    const coords = index.byField.get("move/coords") ?? [];
    expect(coords.length).toBeGreaterThan(0);
    expect(coords[0]!.message).toMatch(/coordinates/);
    const lost = index.byState.get("loco/Lost") ?? [];
    expect(lost.length).toBeGreaterThan(0);
    expect(worst(lost)).toBe("warning");
    // Every node-path problem lands on its node.
    for (const p of problems) {
      const m = /^nodes\[(\d+)\]/.exec(p.path);
      if (m) expect(index.byNode.get(graph.nodes[Number(m[1])]!.id)).toContainEqual(expect.objectContaining({ path: p.path }));
    }
    expect(transitionKey("loco", { from: null, index: 0 })).toBe("loco/@any/0");
  });
});
