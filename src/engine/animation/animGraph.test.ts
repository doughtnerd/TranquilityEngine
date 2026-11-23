// Animation graphs (`myco.animgraph-source@1`, ADR 0372) through their parse and write: every node family, state machines
// with priority-ordered transitions (every `when` and `how`, bridges, interrupt lists), structured conditions over
// every operand, choosers, slots, linked graphs, layers and sync groups round-trip; every reference is checked; the
// limits hold.
import { describe, expect, it } from "vitest";
import {
  animGraphReferences, animGraphToJson, emptyAnimGraph, familyOfKind, formatAnimGraph, GRAPH_FAMILIES, GRAPH_LIMITS, GRAPH_NODE_KINDS, parseAnimGraph, type AnimGraph, type GraphNode,
} from "./animGraph";

const node = (id: string, kind: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, family: familyOfKind(kind)!, kind, name: "", inputs: [], params: {}, ...extra });

function graph(): AnimGraph {
  return {
    format: "myco.animgraph-source@1",
    name: "Locomotion",
    skeleton: "asset:models/hero.glb#Skeleton",
    output: "out",
    parameters: [
      { name: "speed", type: "float", default: 0, replicate: true, predicted: true, computed: false },
      { name: "weapon", type: "int", default: 2, replicate: true, predicted: false, computed: false },
      { name: "dead", type: "bool", default: false, replicate: false, predicted: false, computed: false },
      { name: "canVault", type: "bool", default: true, replicate: false, predicted: false, computed: true },
      { name: "move", type: "vec2", default: [0, 1], replicate: false, predicted: false, computed: false },
      { name: "look", type: "vec3", default: [0, 0, 0], replicate: false, predicted: false, computed: false },
      { name: "aimRot", type: "quat", default: [0, 0, 0, 1], replicate: false, predicted: false, computed: false },
      { name: "target", type: "node", default: "Enemies/Boss", replicate: false, predicted: false, computed: false },
      { name: "aim", type: "float", default: 1, replicate: false, predicted: false, computed: false },
    ],
    nodes: [
      node("idle", "clipPlayer", { params: { clip: "asset:clips/idle.anim.json", loop: true }, position: [0, 100] }),
      node("walk", "clipPlayer", { params: { clip: "asset:models/hero.glb#Anim/Walk", speed: 1.1 } }),
      node("run", "clipPlayer", { params: { clip: "asset:clips/run.anim.json" } }),
      node("moveBs", "blendSpace1D", { inputs: ["walk", "run"], params: { x: "speed", coords: [1.5, 4], sync: true, glideMs: 120 } }),
      node("feet", "syncGroup", { inputs: ["moveBs"] }),
      node("stop", "clipPlayer", { params: { clip: "asset:clips/stop.anim.json" } }),
      node("idles", "random", { inputs: ["idle", "walk"], params: { mode: "shuffle", weights: [2, 1], avoid: 1 } }),
      node("loco", "stateMachine", {
        name: "Base",
        machine: {
          entry: "Move",
          states: [
            { name: "Idle", root: "idles", exit: false, position: [10, 20], transitions: [
              { id: "go", to: "Move", if: { all: [{ param: "speed", op: ">", value: 0.1 }, { param: "dead", op: "==", value: false }] }, when: "now", how: "crossfade", duration: 0.25, shape: "smoothstep", bridge: null, interrupt: "never" },
            ] },
            { name: "Move", root: "feet", exit: false, transitions: [
              { id: "halt", to: "Idle", if: { any: [{ param: "speed", op: "<=", value: 0.1 }, { request: "Stop", op: "==", value: true }] }, when: "exit", how: "bridge", duration: 0.1, shape: "easeOut", bridge: "stop", interrupt: ["go", "die"] },
              { id: "", to: "Idle", if: { all: [{ operand: "normalizedTime", op: ">=", value: 0.9 }, { any: [{ curve: "FootIK", op: "<", value: 0.5 }, { operand: "syncPhase", op: "!=", value: 0 }] }] }, when: "marker:L", how: "inertialize", duration: 0.3, shape: "linear", bridge: null, interrupt: "any" },
              { id: "", to: "Done", if: { all: [{ operand: "stateTime", op: ">", value: 10 }, { param: "weapon", op: "==", value: 3 }, { request: "Skip", op: "!=", value: false }] }, when: 0.75, how: "cut", duration: 0, shape: "linear", bridge: null, interrupt: "never" },
            ] },
            { name: "Done", root: null, exit: true, transitions: [] },
          ],
          anyState: [{ id: "die", to: "Done", if: { param: "dead", op: "==", value: true }, when: "now", how: "cut", duration: 0, shape: "linear", bridge: null, interrupt: "never" }],
        },
      }),
      node("pick", "chooser", { chooser: { rows: [{ if: { param: "weapon", op: ">", value: 0 }, result: "run" }], fallback: "idle" } }),
      node("upper", "slot", { inputs: ["loco"], slot: { name: "UpperBody", group: "Actions" } }),
      node("weapon", "linked", { linked: { name: "Weapon", graph: "asset:graphs/sword.animgraph.json" } }),
      node("layered", "layer", { inputs: ["upper", "weapon"], params: { weight: 0.5 } }),
      node("ik", "twoBoneIk", { inputs: ["layered"], params: { chain: "LeftArm", target: "target", weight: 1 } }),
      node("matcher", "poseDatabase", { params: { database: "asset:anim/loco.posedb.json", tags: ["idle", "start"] } }),
      node("rt", "retarget", { inputs: ["matcher"] }),
      node("phys", "physicsBlend", { inputs: ["rt"] }),
      node("plug", "plugin", { params: { node: "vendor.wobble" } }),
      node("out", "mirror", { name: "Output", inputs: ["ik"] }),
    ],
    layers: [
      { name: "Base", root: "loco", mask: null, mode: "override", weight: 1, weightParameter: null },
      { name: "UpperBody", root: "upper", mask: "asset:masks/upper.mask.json", mode: "additive", weight: 0.75, weightParameter: "aim" },
    ],
  };
}

const reparse = (g: AnimGraph) => parseAnimGraph(JSON.parse(formatAnimGraph(g)));

describe("animation graphs (myco.animgraph-source@1)", () => {
  it("round-trip every family, machine, condition, chooser, slot, linked graph and layer", () => {
    const x = graph();
    expect(new Set(x.nodes.map((n) => n.family))).toEqual(new Set(GRAPH_FAMILIES));
    expect(reparse(x)).toEqual({ value: x, problems: [] });
  });

  it("number kinds as anim-graph does, and know each kind's family", () => {
    expect(GRAPH_NODE_KINDS.sources.indexOf("clipPlayer")).toBe(0);
    expect(GRAPH_NODE_KINDS.sources.indexOf("bindPose")).toBe(5);
    expect(GRAPH_NODE_KINDS.mixing.indexOf("mirror")).toBe(8);
    expect(GRAPH_NODE_KINDS.rig.indexOf("distanceMatch")).toBe(15);
    expect(GRAPH_NODE_KINDS.logic.indexOf("chooser")).toBe(2);
    const all = GRAPH_FAMILIES.flatMap((f) => GRAPH_NODE_KINDS[f]);
    expect(new Set(all).size).toBe(all.length);
    expect(familyOfKind("lookAt")).toBe("rig");
  });

  it("write only what differs from the defaults", () => {
    expect(animGraphToJson(emptyAnimGraph())).toEqual({ format: "myco.animgraph-source@1", parameters: [], nodes: [] });
    expect(parseAnimGraph(animGraphToJson(emptyAnimGraph()))).toEqual({ value: emptyAnimGraph(), problems: [] });
    const json = animGraphToJson(graph()) as { parameters: unknown[]; nodes: Record<string, unknown>[] };
    expect(json.parameters[0]).toEqual({ name: "speed", type: "float", replicate: true, predicted: true });
    const loco = json.nodes.find((n) => n.id === "loco") as { machine: { entry: string; states: { transitions?: unknown[] }[]; anyState: unknown[] } };
    expect(loco.machine.states[0].transitions).toEqual([{ id: "go", to: "Move", if: { all: [{ param: "speed", op: ">", value: 0.1 }, { param: "dead", op: "==", value: false }] }, duration: 0.25, shape: "smoothstep" }]);
    expect(loco.machine.anyState).toEqual([{ id: "die", to: "Done", if: { param: "dead", op: "==", value: true }, how: "cut" }]);
    expect(json.nodes.find((n) => n.id === "feet")).toEqual({ id: "feet", family: "sync", kind: "syncGroup", inputs: ["moveBs"] });
  });

  it("default the entry to the first state", () => {
    const g = graph();
    const loco = g.nodes.find((n) => n.id === "loco")!;
    const machine = { ...loco.machine!, entry: "Idle" };
    const read = reparse({ ...g, nodes: g.nodes.map((n) => (n === loco ? { ...n, machine } : n)) });
    const json = animGraphToJson(read.value) as { nodes: { id: string; machine?: { entry?: string } }[] };
    expect(json.nodes.find((n) => n.id === "loco")!.machine!.entry).toBeUndefined();
    expect(read.value.nodes.find((n) => n.id === "loco")!.machine!.entry).toBe("Idle");
  });

  const base = { format: "myco.animgraph-source@1", parameters: [{ name: "speed", type: "float" }, { name: "on", type: "bool" }, { name: "pos", type: "vec2" }] };
  const withNodes = (nodes: unknown[], extra: Record<string, unknown> = {}) => parseAnimGraph({ ...base, nodes, ...extra });
  const sm = (machine: Record<string, unknown>) => withNodes([{ id: "a", family: "sources", kind: "clipPlayer" }, { id: "m", family: "logic", kind: "stateMachine", machine }]);
  const twoStates = (transition: Record<string, unknown>) => sm({ states: [{ name: "A", root: "a", transitions: [transition] }, { name: "B" }] });
  const transitionOf = (read: ReturnType<typeof parseAnimGraph>) => read.value.nodes[1].machine!.states[0].transitions[0];

  it.each<[string, unknown[], Record<string, unknown>, string]>([
    ["an unknown kind", [{ id: "x", kind: "teleport" }], {}, 'nodes[0].kind: "teleport" isn\'t a node kind; the node is dropped.'],
    ["a family that doesn't match the kind", [{ id: "x", family: "rig", kind: "clipPlayer" }], {}, 'nodes[0].family: "clipPlayer" is a "sources" node, not "rig"; using "sources".'],
    ["a repeated id", [{ id: "x", family: "sources", kind: "bindPose" }, { id: "x", family: "sources", kind: "bindPose" }], {}, 'nodes[1].id: id "x" is used twice; using "node1".'],
    ["an input naming no node", [{ id: "x", family: "mixing", kind: "blend2", inputs: ["nope"] }], {}, 'nodes[0].inputs[0]: "nope" isn\'t a node of this graph; none.'],
    ["a node as its own input", [{ id: "x", family: "mixing", kind: "mirror", inputs: ["x"] }], {}, "nodes[0].inputs[0]: a node can't be its own input; dropped."],
    ["an object parameter", [{ id: "x", family: "sources", kind: "clipPlayer", params: { clip: { path: "a" } } }], {}, "nodes[0].params.clip: a node parameter is a number, true/false, a string, or a list of numbers or of strings; dropped."],
    ["an output naming no node", [], { output: "x" }, 'output: "x" isn\'t a node of this graph; none.'],
    ["a slot without a name", [{ id: "s", family: "slots", kind: "slot" }], {}, 'nodes[0].slot.name: a slot needs a name; using "s".'],
    ["a layer without a root", [], { layers: [{ name: "L" }] }, "layers[0].root: a layer must name its root node; dropped."],
    ["a layer weight parameter that isn't a float", [{ id: "x", family: "sources", kind: "bindPose" }], { layers: [{ name: "L", root: "x", weightParameter: "on" }] }, 'layers[0].weightParameter: "on" isn\'t a float parameter; none.'],
    ["a parameter without a name", [], { parameters: [{ type: "float" }] }, "parameters[0].name: a parameter needs a name (letters, digits, _ and ., not starting with a digit); dropped."],
    ["a parameter default of the wrong type", [], { parameters: [{ name: "n", type: "int", default: 1.5 }] }, "parameters[0].default: isn't a int value; using 0."],
    ["a parameter of an unknown type", [], { parameters: [{ name: "n", type: "string" }] }, 'parameters[0].type: must be one of float, int, bool, vec2, vec3, quat, node; using "float".'],
  ])("fall back on a bad graph value: %s", (_label, nodes, extra, problem) => {
    expect(withNodes(nodes, extra).problems).toEqual([problem]);
  });

  it.each<[string, Record<string, unknown>, string, Record<string, unknown>]>([
    ["a target naming no state", { to: "Z" }, 'nodes[1].machine.states[0].transitions[0].to: "Z" isn\'t a state of this machine; the transition is dropped.', {}],
    ["a bad when", { to: "B", when: "soon" }, 'nodes[1].machine.states[0].transitions[0].when: must be "now", "exit", "marker:<name>" or a normalised time ≥ 0; using "now".', { when: "now" }],
    ["a bridge without its node", { to: "B", how: "bridge" }, 'nodes[1].machine.states[0].transitions[0].bridge: a bridge transition must name its bridge node; using "crossfade".', { how: "crossfade" }],
    ["a cut with a duration", { to: "B", how: "cut", duration: 0.5 }, "nodes[1].machine.states[0].transitions[0].duration: a cut has no duration; dropped.", { duration: 0 }],
    ["an unknown fade shape", { to: "B", shape: "bounce" }, 'nodes[1].machine.states[0].transitions[0].shape: must be one of linear, smoothstep, easeIn, easeOut; using "linear".', { shape: "linear" }],
    ["an interrupter naming no transition", { to: "B", interrupt: ["ghost"] }, 'nodes[1].machine.states[0].transitions[0].interrupt[0]: "ghost" isn\'t another transition of this machine; dropped.', { interrupt: [] }],
    ["a duration out of range", { to: "B", duration: -1 }, "nodes[1].machine.states[0].transitions[0].duration: -1 is outside 0..60; using 0.", { duration: 0 }],
    ["a comparison of an unknown parameter", { to: "B", if: { param: "nope", op: ">", value: 1 } }, 'nodes[1].machine.states[0].transitions[0].if.param: "nope" isn\'t a parameter of this graph; the comparison is dropped.', { if: null }],
    ["a bool parameter with <", { to: "B", if: { param: "on", op: "<", value: true } }, "nodes[1].machine.states[0].transitions[0].if.op: a bool parameter compares with == or != only; dropped.", { if: null }],
    ["a vector parameter", { to: "B", if: { param: "pos", op: "==", value: 1 } }, "nodes[1].machine.states[0].transitions[0].if.param: a vec2 parameter isn't comparable; dropped.", { if: null }],
    ["a float compared with a string", { to: "B", if: { param: "speed", op: ">", value: "fast" } }, "nodes[1].machine.states[0].transitions[0].if.value: must be a number; the comparison is dropped.", { if: null }],
    ["an unknown operand", { to: "B", if: { operand: "health", op: ">", value: 1 } }, "nodes[1].machine.states[0].transitions[0].if.operand: must be one of stateTime, normalizedTime, syncPhase; dropped.", { if: null }],
    ["a request with >", { to: "B", if: { request: "Jump", op: ">" } }, "nodes[1].machine.states[0].transitions[0].if.op: a request compares with == or != only; dropped.", { if: null }],
    ["an empty group", { to: "B", if: { all: [] } }, 'nodes[1].machine.states[0].transitions[0].if: an "all" group needs at least one condition; dropped.', { if: null }],
    ["an unknown op", { to: "B", if: { param: "speed", op: "~", value: 1 } }, 'nodes[1].machine.states[0].transitions[0].if.op: must be one of ==, !=, <, <=, >, >=; using "==".', { if: { param: "speed", op: "==", value: 1 } }],
  ])("fall back on a bad transition: %s", (_label, t, problem, expected) => {
    const read = twoStates(t);
    expect(read.problems).toEqual([problem]);
    if (Object.keys(expected).length) expect(transitionOf(read)).toMatchObject(expected);
  });

  it("drop a repeated state and an entry naming no state, one problem each", () => {
    const read = sm({ entry: "Z", states: [{ name: "A" }, { name: "A" }] });
    expect(read.problems).toEqual(['nodes[1].machine.states[1].name: state "A" is already defined; dropped.', 'nodes[1].machine.entry: "Z" isn\'t a state of this machine; using "A".']);
    expect(read.value.nodes[1].machine!.states.map((s) => s.name)).toEqual(["A"]);
  });

  it("let a condition nest 16 deep, the root counting, and no deeper", () => {
    const nest = (depth: number): unknown => (depth === 1 ? { param: "speed", op: ">", value: 0 } : { all: [nest(depth - 1)] });
    expect(twoStates({ to: "B", if: nest(GRAPH_LIMITS.conditionDepth) }).problems).toEqual([]);
    const deep = twoStates({ to: "B", if: nest(GRAPH_LIMITS.conditionDepth + 1) });
    expect(deep.problems[0]).toBe(`nodes[1].machine.states[0].transitions[0].if${".all[0]".repeat(GRAPH_LIMITS.conditionDepth - 1)}: conditions nest at most ${GRAPH_LIMITS.conditionDepth} deep; dropped.`);
  });

  it("hold the node, parameter, state and transition limits", () => {
    const nodes = Array.from({ length: GRAPH_LIMITS.nodes + 1 }, (_, i) => ({ id: `n${i}`, family: "sources", kind: "bindPose" }));
    const many = parseAnimGraph({ format: "myco.animgraph-source@1", nodes });
    expect(many.value.nodes).toHaveLength(GRAPH_LIMITS.nodes);
    expect(many.problems).toEqual([`nodes: at most ${GRAPH_LIMITS.nodes} nodes; the rest are dropped.`]);
    const parameters = Array.from({ length: GRAPH_LIMITS.parameters + 1 }, (_, i) => ({ name: `p${i}`, type: "float" }));
    expect(parseAnimGraph({ format: "myco.animgraph-source@1", parameters }).problems).toEqual([`parameters: at most ${GRAPH_LIMITS.parameters} parameters; the rest are dropped.`]);
    const states = Array.from({ length: GRAPH_LIMITS.states + 1 }, (_, i) => ({ name: `s${i}` }));
    expect(sm({ states }).problems).toEqual([`nodes[1].machine.states: at most ${GRAPH_LIMITS.states} states; the rest are dropped.`]);
    const transitions = Array.from({ length: GRAPH_LIMITS.transitions + 1 }, () => ({ to: "A" }));
    expect(sm({ states: [{ name: "A", transitions }] }).problems).toEqual([`nodes[1].machine.states[0].transitions: at most ${GRAPH_LIMITS.transitions} transitions; the rest are dropped.`]);
    const terms = Array.from({ length: GRAPH_LIMITS.conditionTerms }, () => ({ param: "speed", op: ">", value: 0 }));
    expect(twoStates({ to: "B", if: { all: terms } }).problems).toEqual([`nodes[1].machine.states[0].transitions[0].if.all[${GRAPH_LIMITS.conditionTerms - 1}]: a condition has at most ${GRAPH_LIMITS.conditionTerms} terms; dropped.`]);
  });

  it("name the files their nodes, linked graphs and layers reference", () => {
    expect(animGraphReferences(graph())).toEqual([
      "models/hero.glb", "clips/idle.anim.json", "clips/run.anim.json", "clips/stop.anim.json", "graphs/sword.animgraph.json", "anim/loco.posedb.json", "masks/upper.mask.json",
    ]);
  });
});
