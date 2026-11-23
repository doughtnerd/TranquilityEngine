// The live overlay's view model (ADR 0373 "Live debugger"; T52): a debug report (records as the core writes them, built
// here against the compile's tables) named by the graph editor's ids: node weights and phases, machine states, each
// candidate transition's blocker as a sentence (a false condition with its failing comparison and the operand's value),
// and request lifetimes.
import { describe, expect, it } from "vitest";
import { parseAnimGraph } from "../../../../engine/animation/animGraph";
import { compileAnimGraph } from "../../../../engine/animation/graphCompile";
import type { DebugMachineRecord, DebugReport, DebugTransitionRecord } from "../../runtime/features/debug/report";
import { BLOCK_CONDITION, BLOCK_INTERRUPT, BLOCK_READY, BLOCK_SHADOWED, BLOCK_TRAVEL, BLOCK_WHEN } from "../../runtime/wasm/wire/debug";
import { conditionAt, overlayModel, transitionAt } from "./overlayLogic";

const NONE = 0xffffffff;
const graph = parseAnimGraph({
  format: "myco.animgraph-source@1",
  output: "loco",
  parameters: [
    { name: "speed", type: "float" },
    { name: "grounded", type: "bool", default: true },
    { name: "combo", type: "int" },
  ],
  nodes: [
    { id: "idle", family: "sources", kind: "clipPlayer", params: { clip: "asset:idle.anim" } },
    { id: "run", family: "sources", kind: "clipPlayer", params: { clip: "asset:run.anim" } },
    {
      id: "loco", family: "logic", kind: "stateMachine",
      machine: {
        entry: "Idle",
        states: [
          {
            name: "Idle", root: "idle",
            transitions: [
              { to: "Run", if: { all: [{ param: "grounded", op: "==", value: true }, { param: "speed", op: ">", value: 0.5 }] } },
              { to: "Run", if: { param: "combo", op: ">=", value: 2 } },
              { to: "Run", when: "exit" },
              { to: "Run", when: 0.75 },
              { to: "Run", when: "marker:Step" },
            ],
          },
          { name: "Run", root: "run", transitions: [{ to: "Idle", if: { request: "Stop" } }] },
        ],
        anyState: [{ to: "Idle", if: { operand: "stateTime", op: ">", value: 3 } }],
      },
    },
  ],
}).value;
const tables = compileAnimGraph(graph);
const T = (path: string) => tables.transitions.indexOf(path);
const C = (path: string) => tables.conditions.indexOf(path);
const N = (id: string) => tables.nodes.indexOf(id);
const IDLE = "nodes[2].machine.states[0]";

const machine = (extra: Partial<DebugMachineRecord> = {}): DebugMachineRecord => ({
  machine: 0, current: 0, target: NONE, active: NONE, elapsed: 0, duration: 0, stateTime: 1.25, normalized: 0.4, travel: NONE, lastFired: NONE, entries: 1, ...extra,
});
const cand = (transition: number, blocker: number, detail = 0, value = 0): DebugTransitionRecord => ({ machine: 0, transition, target: 1, blocker, detail, value });

function report(extra: Partial<DebugReport> = {}): DebugReport {
  return {
    instance: 1,
    nodes: [
      { node: N("loco"), weight: 1, clip: 0, time: 0, normalized: 0 },
      { node: N("idle"), weight: 0.75, clip: 7, time: 0.5, normalized: 0.25 },
      { node: N("run"), weight: 0.25, clip: 8, time: 0.1, normalized: 0.125 },
    ],
    machines: [machine()],
    transitions: [],
    requests: [],
    dropped: 0,
    ...extra,
  };
}

describe("overlayModel", () => {
  it("names active nodes by id with their weights and phases", () => {
    const o = overlayModel(graph, tables, report());
    expect(o.nodes.get("idle")).toEqual({ weight: 0.75, time: 0.5, normalized: 0.25 });
    expect(o.nodes.get("run")?.weight).toBe(0.25);
    expect(o.nodes.has("missing")).toBe(false);
  });

  it("names a machine's current and target states, its fading transition and the last one fired", () => {
    const o = overlayModel(graph, tables, report({ machines: [machine({ current: 1, target: 0, active: T(`${IDLE}.transitions[0]`), elapsed: 0.05, duration: 0.2, lastFired: T("nodes[2].machine.anyState[0]") })] }));
    expect(o.machines.get("loco")).toEqual({
      current: "Run", target: "Idle", travel: null, active: { from: "Idle", index: 0 }, fade: 0.25, stateTime: 1.25, normalized: 0.4, lastFired: { from: null, index: 0 },
    });
    // A finished fade is no transition in progress.
    expect(overlayModel(graph, tables, report({ machines: [machine({ active: 2, elapsed: 0.2, duration: 0.2 })] })).machines.get("loco")?.active).toBeNull();
  });

  it("says why each candidate doesn't fire, by its transition key", () => {
    const o = overlayModel(graph, tables, report({
      transitions: [
        cand(T("nodes[2].machine.anyState[0]"), BLOCK_CONDITION, C("nodes[2].machine.anyState[0].if"), 1.25),
        cand(T(`${IDLE}.transitions[0]`), BLOCK_CONDITION, C(`${IDLE}.transitions[0].if.all[1]`), 0.2),
        cand(T(`${IDLE}.transitions[1]`), BLOCK_READY),
        cand(T(`${IDLE}.transitions[2]`), BLOCK_WHEN),
        cand(T(`${IDLE}.transitions[3]`), BLOCK_WHEN),
        cand(T(`${IDLE}.transitions[4]`), BLOCK_WHEN),
      ],
    }));
    const why = (key: string) => o.transitions.get(key);
    expect(why("loco/@any/0")).toEqual({ blocker: "condition", why: "Its condition is false: stateTime > 3 fails, because state time is 1.25." });
    expect(why("loco/Idle/0")).toEqual({ blocker: "condition", why: "Its condition is false: speed > 0.5 fails, because speed is 0.20." });
    expect(why("loco/Idle/1")).toEqual({ blocker: "ready", why: "Ready: it fires this frame." });
    expect(why("loco/Idle/2")?.why).toBe("It waits for the state's exit time (normalised time is 0.40).");
    expect(why("loco/Idle/3")?.why).toBe("It waits for normalised time 0.75 (normalised time is 0.40).");
    expect(why("loco/Idle/4")?.why).toBe('It waits for the marker "Step".');
  });

  it("words each operand kind's current value", () => {
    const o = overlayModel(graph, tables, report({
      machines: [machine({ current: 1 })],
      transitions: [cand(T("nodes[2].machine.states[1].transitions[0]"), BLOCK_CONDITION, C("nodes[2].machine.states[1].transitions[0].if"), 0)],
    }));
    expect(o.transitions.get("loco/Run/0")?.why).toBe("Its condition is false: request Stop fails, because request Stop isn't live.");
    const bools = overlayModel(graph, tables, report({ transitions: [cand(T(`${IDLE}.transitions[0]`), BLOCK_CONDITION, C(`${IDLE}.transitions[0].if.all[0]`), 0)] }));
    expect(bools.transitions.get("loco/Idle/0")?.why).toBe("Its condition is false: grounded == true fails, because grounded is false.");
    const ints = overlayModel(graph, tables, report({ transitions: [cand(T(`${IDLE}.transitions[1]`), BLOCK_CONDITION, C(`${IDLE}.transitions[1].if`), 1)] }));
    expect(ints.transitions.get("loco/Idle/1")?.why).toBe("Its condition is false: combo >= 2 fails, because combo is 1.");
  });

  it("explains priority, interruption and travel blockers", () => {
    const o = overlayModel(graph, tables, report({
      transitions: [
        cand(T(`${IDLE}.transitions[1]`), BLOCK_SHADOWED, T(`${IDLE}.transitions[0]`)),
        cand(T(`${IDLE}.transitions[2]`), BLOCK_INTERRUPT),
        cand(T(`${IDLE}.transitions[3]`), BLOCK_TRAVEL),
      ],
    }));
    expect(o.transitions.get("loco/Idle/1")).toEqual({ blocker: "shadowed", why: "Ready, but transition 1 is tried first and fires instead." });
    expect(o.transitions.get("loco/Idle/2")).toEqual({ blocker: "interrupt", why: "The transition in progress doesn't let it interrupt." });
    expect(o.transitions.get("loco/Idle/3")).toEqual({ blocker: "travel", why: "The machine is travelling along another path." });
  });

  it("names requests with their lifetimes", () => {
    const stop = tables.strings.indexOf("Stop");
    const o = overlayModel(graph, tables, report({ requests: [{ name: stop, life: 0.15 }] }));
    expect(o.requests).toEqual([{ name: "Stop", life: 0.15 }]);
  });
});

describe("transition and condition paths", () => {
  it("resolve to the editor's places and condition terms", () => {
    expect(transitionAt(graph, `${IDLE}.transitions[3]`)?.ref).toEqual({ from: "Idle", index: 3 });
    expect(transitionAt(graph, "nodes[2].machine.anyState[0]")?.ref).toEqual({ from: null, index: 0 });
    expect(transitionAt(graph, "nodes[0].params.clip")).toBeNull();
    expect(conditionAt(graph, `${IDLE}.transitions[0].if.all[1]`)).toEqual({ param: "speed", op: ">", value: 0.5 });
    expect(conditionAt(graph, `${IDLE}.transitions[0].if.any[0]`)).toBeNull();
    expect(conditionAt(graph, undefined)).toBeNull();
  });
});
