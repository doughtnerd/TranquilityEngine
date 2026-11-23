// State machine edits (T51; D51–D54) through their interface: states and transitions round-trip through the format;
// reordering a transition changes its priority (its place in the file); transition fields are checked (a cut has no
// duration, a bridge needs its node, interrupt lists name other transitions and follow renames); duplicate and "@" names
// are refused; the fade preview is audio's curve for each core shape (`AUDIO_FADE_SHAPE`); "Add as state" from a clip
// drop makes a clip player and a state playing it.
import { describe, expect, it } from "vitest";
import { emptyAnimGraph, formatAnimGraph, parseAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { compileAnimGraph } from "../../../../engine/animation/graphCompile";
import { refusalOf, type EditResult } from "../../../../editor/sdk";
import { addNode, nodeById } from "./graphEditLogic";
import {
  addClipAsState, addState, addTransition, fadePreview, interruptChoices, moveTransition, priorityLabel, removeState, removeTransition, renameState, setEntry, setStateRoot, setTransition, transitionsOf,
} from "./machineLogic";

const ok = <T>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
function roundTrip(g: AnimGraph): AnimGraph {
  const read = parseAnimGraph(JSON.parse(formatAnimGraph(g)));
  expect(read.problems).toEqual([]);
  expect(read.value).toEqual(g);
  return g;
}
const machineOf = (g: AnimGraph) => nodeById(g, "stateMachine")!.machine!;

/** A machine with states Idle, Walk, Run (each playing a clip). */
function loco(): AnimGraph {
  let g = ok(addNode(emptyAnimGraph(), "logic", "stateMachine", [0, 0])).graph;
  for (const name of ["Idle", "Walk", "Run"]) {
    const p = ok(addNode(g, "sources", "clipPlayer", [0, 0], { clip: `asset:clips/${name.toLowerCase()}.anim.json` }));
    g = ok(addState(p.graph, "stateMachine", [0, 0], name, p.id)).graph;
  }
  return g;
}

describe("states (T51)", () => {
  it("adds states with unique names; the first is the entry; they compile", () => {
    const g = loco();
    expect(machineOf(g).states.map((s) => s.name)).toEqual(["Idle", "Walk", "Run"]);
    expect(ok(addState(g, "stateMachine", [0, 0], "Idle")).state).toBe("Idle 2");
    roundTrip(g);
    expect(compileAnimGraph(g).problems.filter((p) => p.severity === "error")).toEqual([]);
  });

  it("renames a state with the transitions into it and the entry; refuses taken, empty and @ names", () => {
    let g = ok(addTransition(loco(), "stateMachine", "Idle", "Walk"));
    g = ok(setEntry(g, "stateMachine", "Walk"));
    expect(refusalOf(renameState(g, "stateMachine", "Walk", "Run"))).toBe('another state is named "Run"');
    expect(refusalOf(renameState(g, "stateMachine", "Walk", " "))).toBe("a state needs a name");
    expect(refusalOf(renameState(g, "stateMachine", "Walk", "@any"))).toMatch(/can't start with @/);
    g = ok(renameState(g, "stateMachine", "Walk", "Jog"));
    expect(machineOf(g).entry).toBe("Jog");
    expect(transitionsOf(machineOf(g), "Idle")[0]!.to).toBe("Jog");
    roundTrip(g);
  });

  it("removes a state with the transitions into it and their ids from interrupt lists", () => {
    let g = loco();
    g = ok(addTransition(g, "stateMachine", "Idle", "Walk"));
    g = ok(addTransition(g, "stateMachine", "Idle", "Run"));
    g = ok(setTransition(g, "stateMachine", { from: "Idle", index: 1 }, { id: "toRun" }));
    g = ok(setTransition(g, "stateMachine", { from: "Idle", index: 0 }, { interrupt: ["toRun"] }));
    g = ok(removeState(g, "stateMachine", "Run"));
    const t = transitionsOf(machineOf(g), "Idle");
    expect(t.map((x) => x.to)).toEqual(["Walk"]);
    expect(t[0]!.interrupt).toBe("never");
    roundTrip(g);
  });

  it("refuses a state root that would close a cycle through its machine", () => {
    let g = loco();
    const ts = ok(addNode(g, "mixing", "timeScale", [0, 0]));
    g = ts.graph;
    g = { ...g, nodes: g.nodes.map((n) => (n.id === ts.id ? { ...n, inputs: ["stateMachine"] } : n)) };
    expect(refusalOf(setStateRoot(g, "stateMachine", "Idle", ts.id))).toMatch(/cycle/);
    expect(refusalOf(setStateRoot(g, "stateMachine", "Idle", "stateMachine"))).toMatch(/its own machine/);
  });
});

describe("transitions (T51)", () => {
  it("lists transitions in priority order: reordering changes which is tried first, in the file", () => {
    let g = loco();
    g = ok(addTransition(g, "stateMachine", "Idle", "Walk"));
    g = ok(addTransition(g, "stateMachine", "Idle", "Run"));
    g = ok(addTransition(g, "stateMachine", null, "Idle"));
    expect(priorityLabel({ from: "Idle", index: 0 })).toBe("1");
    expect(priorityLabel({ from: null, index: 0 })).toBe("A1");
    g = ok(moveTransition(g, "stateMachine", { from: "Idle", index: 1 }, 0));
    expect(transitionsOf(machineOf(g), "Idle").map((t) => t.to)).toEqual(["Run", "Walk"]);
    const file = JSON.parse(formatAnimGraph(g)) as { nodes: { machine?: { states: { transitions?: { to: string }[] }[] } }[] };
    expect(file.nodes[0]!.machine!.states[0]!.transitions!.map((t) => t.to)).toEqual(["Run", "Walk"]);
    expect(refusalOf(moveTransition(g, "stateMachine", { from: "Idle", index: 0 }, 5))).toBe("there's no such place");
    roundTrip(g);
  });

  it("checks transition fields: cut, bridge, duration, when, shape", () => {
    let g = ok(addTransition(loco(), "stateMachine", "Idle", "Walk"));
    const ref = { from: "Idle", index: 0 } as const;
    g = ok(setTransition(g, "stateMachine", ref, { how: "cut" }));
    expect(transitionsOf(machineOf(g), "Idle")[0]!.duration).toBe(0);
    expect(refusalOf(setTransition(g, "stateMachine", ref, { duration: 0.3 }))).toBe("a cut has no duration");
    g = ok(setTransition(g, "stateMachine", ref, { how: "crossfade" }));
    expect(transitionsOf(machineOf(g), "Idle")[0]!.duration).toBe(0.2);
    expect(refusalOf(setTransition(g, "stateMachine", ref, { how: "bridge" }))).toMatch(/needs its bridge node/);
    g = ok(setTransition(g, "stateMachine", ref, { how: "bridge", bridge: "clipPlayer2" }));
    expect(refusalOf(setTransition(g, "stateMachine", ref, { duration: -1 }))).toMatch(/0 seconds or more/);
    expect(refusalOf(setTransition(g, "stateMachine", ref, { when: -0.5 }))).toMatch(/0 or more/);
    expect(refusalOf(setTransition(g, "stateMachine", ref, { when: "marker:" }))).toMatch(/needs a name/);
    g = ok(setTransition(g, "stateMachine", ref, { when: "marker:Foot", shape: "easeOut", duration: 0.35 }));
    roundTrip(g);
    expect(compileAnimGraph(g).problems.filter((p) => p.severity === "error")).toEqual([]);
  });

  it("names transitions uniquely; interrupt lists name other transitions and follow a rename", () => {
    let g = loco();
    g = ok(addTransition(g, "stateMachine", "Idle", "Walk"));
    g = ok(addTransition(g, "stateMachine", "Walk", "Run"));
    const a = { from: "Idle", index: 0 } as const, b = { from: "Walk", index: 0 } as const;
    g = ok(setTransition(g, "stateMachine", a, { id: "go" }));
    expect(refusalOf(setTransition(g, "stateMachine", b, { id: "go" }))).toBe('another transition is named "go"');
    g = ok(setTransition(g, "stateMachine", b, { id: "sprint" }));
    expect(refusalOf(setTransition(g, "stateMachine", a, { interrupt: ["go"] }))).toBe("a transition can't interrupt itself");
    expect(refusalOf(setTransition(g, "stateMachine", a, { interrupt: ["nope"] }))).toMatch(/isn't another transition/);
    expect(interruptChoices(machineOf(g), a).map((c) => c.id)).toEqual(["sprint"]);
    g = ok(setTransition(g, "stateMachine", a, { interrupt: ["sprint"] }));
    g = ok(setTransition(g, "stateMachine", b, { id: "dash" }));
    expect(transitionsOf(machineOf(g), "Idle")[0]!.interrupt).toEqual(["dash"]);
    g = ok(removeTransition(g, "stateMachine", b));
    expect(transitionsOf(machineOf(g), "Idle")[0]!.interrupt).toBe("never");
    roundTrip(g);
  });
});

describe("fade shape preview (D53)", () => {
  it("is audio's curve for each core shape (AUDIO_FADE_SHAPE)", () => {
    const at = (shape: Parameters<typeof fadePreview>[0], u: number) => fadePreview(shape, 4)[u * 4]!;
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      expect(at("linear", u)).toBeCloseTo(u, 12);
      expect(at("smoothstep", u)).toBeCloseTo(u * u * (3 - 2 * u), 12);
      expect(at("easeIn", u)).toBeCloseTo(u * u, 12);
      expect(at("easeOut", u)).toBeCloseTo(1 - (1 - u) * (1 - u), 12);
    }
  });
});

describe("Add as state (a clip dropped on an Animator with a graph)", () => {
  it("adds a clip player and a state playing it to the output's machine", () => {
    const g = loco();
    const r = ok(addClipAsState(g, "asset:clips/jump.anim.json", "jump"));
    const state = machineOf(r.graph).states.at(-1)!;
    expect(state).toMatchObject({ name: "jump", root: r.id });
    expect(nodeById(r.graph, r.id)).toMatchObject({ family: "sources", kind: "clipPlayer", params: { clip: "asset:clips/jump.anim.json" } });
    expect(r.graph.output).toBe("stateMachine");
    roundTrip(r.graph);
  });

  it("makes a machine (the output) in an empty graph; refuses a graph whose output isn't a machine", () => {
    const r = ok(addClipAsState(emptyAnimGraph(), "asset:clips/idle.anim.json", "idle"));
    expect(r.graph.output).toBe(r.machine);
    expect(machineOf(r.graph).states.map((s) => s.name)).toEqual(["idle"]);
    roundTrip(r.graph);
    const plain = ok(addNode(emptyAnimGraph(), "sources", "clipPlayer", [0, 0])).graph;
    expect(refusalOf(addClipAsState(plain, "asset:clips/idle.anim.json", "idle"))).toMatch(/no state machine/);
  });
});
