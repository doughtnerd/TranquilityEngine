// The graph editor's pose-node edits (T51) through their interface: every accepted edit writes a graph the format reads
// back unchanged with no problems (a parse round trip), and the refusals a user meets come back as refused-or-next
// results with their reason (type mismatch, cycle, duplicate name, inputs out of order).
import { describe, expect, it } from "vitest";
import { emptyAnimGraph, formatAnimGraph, parseAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { compileAnimGraph } from "../../../../engine/animation/graphCompile";
import { refusalOf, type EditResult } from "../../../../editor/sdk";
import {
  addChooserRow, addLayer, addNode, connect, disconnect, inputPins, moveChooserRow, moveNodes, removeNodes, renameNode, setChooserCondition, setChooserFallback, setLayer, setLinked, setNodeParam, setOutput, setSlot, whyNotConnect, type Added,
} from "./graphEditLogic";

const ok = <T>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const add = (g: AnimGraph, family: Parameters<typeof addNode>[1], kind: string, params = {}): Added => ok(addNode(g, family, kind, [0, 0], params));

/** The graph as the file writes it, read back: no problems, and the same graph. */
function roundTrip(g: AnimGraph): AnimGraph {
  const read = parseAnimGraph(JSON.parse(formatAnimGraph(g)));
  expect(read.problems).toEqual([]);
  expect(read.value).toEqual(g);
  return read.value;
}

const withParams = (g: AnimGraph): AnimGraph => ({
  ...g,
  parameters: [
    { name: "speed", type: "float", default: 0, replicate: false, predicted: false, computed: false },
    { name: "grounded", type: "bool", default: false, replicate: false, predicted: false, computed: false },
  ],
});

describe("pose nodes (T51)", () => {
  it("adds nodes from the catalogue with unique ids; the first becomes the output", () => {
    let g = emptyAnimGraph();
    const a = add(g, "sources", "clipPlayer", { clip: "asset:clips/walk.anim.json" });
    g = a.graph;
    expect(a.id).toBe("clipPlayer");
    expect(g.output).toBe("clipPlayer");
    const b = add(g, "sources", "clipPlayer");
    expect(b.id).toBe("clipPlayer2");
    expect(b.graph.output).toBe("clipPlayer");
    roundTrip(b.graph);
  });

  it("gives side-table kinds their tables, which round-trip", () => {
    let g = emptyAnimGraph();
    g = add(g, "logic", "stateMachine").graph;
    g = add(g, "logic", "chooser").graph;
    g = add(g, "slots", "slot").graph;
    g = add(g, "slots", "linked").graph;
    const [m, c, s, l] = g.nodes;
    expect(m!.machine).toEqual({ entry: null, states: [], anyState: [] });
    expect(c!.chooser).toEqual({ rows: [], fallback: null });
    expect(s!.slot).toEqual({ name: "Slot", group: null });
    expect(l!.linked).toEqual({ name: "Linked", graph: null });
    roundTrip(g);
  });

  it("connects, disconnects and removes, keeping a blend space's coordinates beside their inputs", () => {
    let g = emptyAnimGraph();
    g = add(g, "sources", "blendSpace1D").graph;
    for (const clip of ["walk", "run", "sprint"]) g = add(g, "sources", "clipPlayer", { clip: `asset:clips/${clip}.anim.json` }).graph;
    g = ok(connect(g, "clipPlayer", "blendSpace1D", 0));
    g = ok(connect(g, "clipPlayer2", "blendSpace1D", 1));
    g = ok(connect(g, "clipPlayer3", "blendSpace1D", 2));
    g = ok(setNodeParam(g, "blendSpace1D", "coords", [0, 1.5, 4]));
    expect(g.nodes[0]!.inputs).toEqual(["clipPlayer", "clipPlayer2", "clipPlayer3"]);
    roundTrip(g);
    // A variadic kind shows one free pin after its wired ones.
    expect(inputPins(g.nodes[0]!).map((p) => p.label)).toEqual(["samples 1", "samples 2", "samples 3", "samples 4"]);
    const without = disconnect(g, "blendSpace1D", 1);
    expect(without.nodes[0]!.inputs).toEqual(["clipPlayer", "clipPlayer3"]);
    expect(without.nodes[0]!.params.coords).toEqual([0, 4]);
    const removed = removeNodes(g, ["clipPlayer"]);
    expect(removed.nodes.map((n) => n.id)).toEqual(["blendSpace1D", "clipPlayer2", "clipPlayer3"]);
    expect(removed.nodes[0]!.params.coords).toEqual([1.5, 4]);
    roundTrip(removed);
    expect(compileAnimGraph(removed).problems.filter((p) => p.severity === "error")).toEqual([]);
  });

  it("removing a node clears every reference to it (the output, layers, state roots, chooser rows)", () => {
    let g = withParams(emptyAnimGraph());
    g = add(g, "logic", "chooser").graph;
    g = add(g, "sources", "clipPlayer").graph;
    g = ok(addChooserRow(g, "chooser", "clipPlayer", { param: "grounded", op: "==", value: true }));
    g = ok(setChooserFallback(g, "chooser", "clipPlayer"));
    g = ok(addLayer(g, "clipPlayer"));
    g = ok(setOutput(g, "clipPlayer"));
    const r = removeNodes(g, ["clipPlayer"]);
    expect(r.output).toBeNull();
    expect(r.layers).toEqual([]);
    expect(r.nodes[0]!.chooser).toEqual({ rows: [], fallback: null });
    roundTrip(r);
  });

  it("refuses a cycle, a node feeding itself, and an input past the ones wired", () => {
    let g = emptyAnimGraph();
    g = add(g, "mixing", "blend2").graph;
    g = add(g, "mixing", "timeScale").graph;
    g = ok(connect(g, "blend2", "timeScale", 0));
    expect(refusalOf(connect(g, "timeScale", "blend2", 0))).toMatch(/cycle/);
    expect(whyNotConnect(g, "blend2", "blend2", 0)).toMatch(/own input/);
    g = add(g, "sources", "clipPlayer").graph;
    expect(refusalOf(connect(g, "clipPlayer", "blend2", 1))).toMatch(/wire a first/);
    expect(refusalOf(connect(g, "clipPlayer", "timeScale", 1))).toMatch(/at most 1 input/);
    expect(refusalOf(connect(g, "blend2", "clipPlayer", 0))).toMatch(/no inputs/);
  });

  it("types parameters by the schema: ranges, enums, bindings to graph parameters of the right type", () => {
    let g = withParams(emptyAnimGraph());
    g = add(g, "sources", "clipPlayer").graph;
    g = add(g, "sources", "blendSpace1D").graph;
    g = add(g, "rig", "lookAt").graph;
    expect(refusalOf(setNodeParam(g, "clipPlayer", "start", -1))).toMatch(/at least 0/);
    expect(refusalOf(setNodeParam(g, "clipPlayer", "loop", "pingpong"))).toMatch(/one of clip, loop, once/);
    expect(refusalOf(setNodeParam(g, "clipPlayer", "speed", true))).toMatch(/type mismatch/);
    expect(refusalOf(setNodeParam(g, "clipPlayer", "nope", 1))).toMatch(/no parameter "nope"/);
    // A parameter reference takes a float; "grounded" is a bool.
    expect(refusalOf(setNodeParam(g, "blendSpace1D", "x", "grounded"))).toBe("type mismatch: x takes a float parameter; grounded is bool");
    g = ok(setNodeParam(g, "blendSpace1D", "x", "speed"));
    // An animatable float takes a number or a float parameter.
    expect(refusalOf(setNodeParam(g, "lookAt", "weight", "grounded"))).toMatch(/type mismatch/);
    g = ok(setNodeParam(g, "lookAt", "weight", "speed"));
    // The default is left out, as the file writes it.
    g = ok(setNodeParam(g, "clipPlayer", "speed", 2));
    expect(g.nodes[0]!.params).toEqual({ speed: 2 });
    g = ok(setNodeParam(g, "clipPlayer", "speed", 1));
    expect(g.nodes[0]!.params).toEqual({});
    roundTrip(g);
  });

  it("renames a node with its references; refuses taken or malformed ids", () => {
    let g = emptyAnimGraph();
    g = add(g, "mixing", "timeScale").graph;
    g = add(g, "sources", "clipPlayer").graph;
    g = ok(connect(g, "clipPlayer", "timeScale", 0));
    g = ok(addLayer(g, "clipPlayer"));
    expect(refusalOf(renameNode(g, "clipPlayer", "timeScale"))).toBe('another node is named "timeScale"');
    expect(refusalOf(renameNode(g, "clipPlayer", "2walk"))).toMatch(/letters, digits and _/);
    g = ok(renameNode(g, "clipPlayer", "walk"));
    expect(g.nodes[0]!.inputs).toEqual(["walk"]);
    expect(g.layers[0]!.root).toBe("walk");
    roundTrip(g);
  });

  it("edits slots, linked graphs and layers with their refusals", () => {
    let g = withParams(emptyAnimGraph());
    g = add(g, "slots", "slot").graph;
    g = add(g, "slots", "slot").graph;
    expect(refusalOf(setSlot(g, "slot2", { name: "Slot" }))).toBe('another slot is named "Slot"');
    g = ok(setSlot(g, "slot2", { name: "UpperBody", group: "Actions" }));
    g = add(g, "slots", "linked").graph;
    expect(refusalOf(setLinked(g, "linked", { graph: "asset:graphs/me.animgraph.json" }, "graphs/me.animgraph.json"))).toMatch(/can't link itself/);
    // Every written form of the reference names the graph itself (ADR 0459): the runtime reads `asset:./x` as `x`.
    for (const graph of ["asset:./graphs/me.animgraph.json", "/graphs/me.animgraph.json", "graphs/me.animgraph.json"]) {
      expect(refusalOf(setLinked(g, "linked", { graph }, "graphs/me.animgraph.json"))).toMatch(/can't link itself/);
    }
    g = ok(setLinked(g, "linked", { name: "Weapon", graph: "asset:graphs/sword.animgraph.json" }, "graphs/me.animgraph.json"));
    g = ok(addLayer(g, "slot"));
    expect(refusalOf(setLayer(g, "Layer", { weightParameter: "grounded" }))).toMatch(/type mismatch/);
    expect(refusalOf(setLayer(g, "Layer", { weight: 2 }))).toMatch(/0 to 1/);
    g = ok(setLayer(g, "Layer", { weightParameter: "speed", mask: "asset:masks/upper.mask.json", mode: "additive" }));
    roundTrip(g);
  });

  it("keeps chooser rows in order, each with a condition", () => {
    let g = withParams(emptyAnimGraph());
    g = add(g, "logic", "chooser").graph;
    g = add(g, "sources", "clipPlayer").graph;
    g = add(g, "sources", "clipPlayer").graph;
    g = ok(addChooserRow(g, "chooser", "clipPlayer", { param: "grounded", op: "==", value: true }));
    g = ok(addChooserRow(g, "chooser", "clipPlayer2", { param: "speed", op: ">", value: 1 }));
    g = ok(moveChooserRow(g, "chooser", 1, 0));
    expect(g.nodes[0]!.chooser!.rows.map((r) => r.result)).toEqual(["clipPlayer2", "clipPlayer"]);
    expect(refusalOf(setChooserCondition(g, "chooser", 0, null))).toBe("a chooser row needs a condition");
    expect(refusalOf(addChooserRow(g, "chooser", "chooser", { param: "speed", op: ">", value: 1 }))).toMatch(/itself/);
    roundTrip(g);
  });

  it("moves nodes to whole units", () => {
    let g = add(emptyAnimGraph(), "sources", "clipPlayer").graph;
    g = moveNodes(g, new Map([["clipPlayer", { x: 10.4, y: -3.6 }]]));
    expect(g.nodes[0]!.position).toEqual([10, -4]);
    roundTrip(g);
  });
});
