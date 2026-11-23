// Stories (ADR 0219) for the live debugger's overlay on T51's canvases (ADR 0373 "Live debugger"; T52): a debug report
// (records as the core writes them, against the compile's tables) turned into the overlay and provided through the
// `LiveOverlay` context. The state machine shows its current state outlined, a transition in progress, and each
// candidate coloured by its blocker with the "why not" tooltip; the pose canvas shows active nodes' weight bars.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect } from "storybook/test";
import { parseAnimGraph } from "../../../../engine/animation/animGraph";
import { compileAnimGraph } from "../../../../engine/animation/graphCompile";
import type { DebugReport } from "../../runtime/features/debug/report";
import { BLOCK_CONDITION, BLOCK_SHADOWED, BLOCK_WHEN } from "../../runtime/wasm/wire/debug";
import { MachineCanvas } from "../graphEditor/MachineCanvas";
import type { TransitionRef } from "../graphEditor/machineLogic";
import { PoseCanvas } from "../graphEditor/PoseCanvas";
import { indexProblems } from "../graphEditor/problemLogic";
import { LiveOverlay } from "./overlayContext";
import { overlayModel } from "./overlayLogic";
import "../../../../editor/graph/graph.css";
import "../graphEditor/animGraphEditor.css";
import "./debugger.css";

const NONE = 0xffffffff;
const graph = parseAnimGraph({
  format: "myco.animgraph-source@1",
  output: "loco",
  parameters: [{ name: "speed", type: "float" }, { name: "crouch", type: "bool" }],
  nodes: [
    { id: "idle", family: "sources", kind: "clipPlayer", position: [0, 0], params: { clip: "asset:idle.anim" } },
    { id: "walk", family: "sources", kind: "clipPlayer", position: [0, 130], params: { clip: "asset:walk.anim" } },
    { id: "run", family: "sources", kind: "clipPlayer", position: [0, 260], params: { clip: "asset:run.anim" } },
    {
      id: "loco", family: "logic", kind: "stateMachine", position: [260, 120],
      machine: {
        entry: "Idle",
        states: [
          { name: "Idle", root: "idle", position: [220, 40], transitions: [{ to: "Walk", if: { param: "speed", op: ">", value: 0.1 } }, { to: "Crouch", if: { param: "crouch", op: "==", value: true } }] },
          { name: "Walk", root: "walk", position: [460, 40], transitions: [{ to: "Run", if: { param: "speed", op: ">", value: 3 } }, { to: "Idle", when: "exit" }, { to: "Run", if: { param: "speed", op: ">", value: 1 } }] },
          { name: "Run", root: "run", position: [460, 180], transitions: [{ to: "Walk" }] },
          { name: "Crouch", root: "idle", position: [220, 180] },
        ],
      },
    },
  ],
}).value;
const tables = compileAnimGraph(graph);
const T = (path: string) => tables.transitions.indexOf(path);
const W = "nodes[3].machine.states[1]";

/** Walk is current, fading in from Idle; its three candidates are blocked three ways. */
const report: DebugReport = {
  instance: 1,
  nodes: [
    { node: tables.nodes.indexOf("loco"), weight: 1, clip: 0, time: 0, normalized: 0 },
    { node: tables.nodes.indexOf("walk"), weight: 0.6, clip: 2, time: 0.3, normalized: 0.3 },
    { node: tables.nodes.indexOf("idle"), weight: 0.4, clip: 1, time: 1.1, normalized: 0.55 },
  ],
  machines: [{ machine: 0, current: 1, target: NONE, active: T("nodes[3].machine.states[0].transitions[0]"), elapsed: 0.12, duration: 0.2, stateTime: 0.12, normalized: 0.3, travel: NONE, lastFired: T("nodes[3].machine.states[0].transitions[0]"), entries: 2 }],
  transitions: [
    { machine: 0, transition: T(`${W}.transitions[0]`), target: 2, blocker: BLOCK_CONDITION, detail: tables.conditions.indexOf(`${W}.transitions[0].if`), value: 1.4 },
    { machine: 0, transition: T(`${W}.transitions[1]`), target: 0, blocker: BLOCK_WHEN, detail: 0, value: 0 },
    { machine: 0, transition: T(`${W}.transitions[2]`), target: 2, blocker: BLOCK_SHADOWED, detail: T(`${W}.transitions[0]`), value: 0 },
  ],
  requests: [],
  dropped: 0,
};
const overlay = overlayModel(graph, tables, report);
const problems = indexProblems(graph, []);

function Machine() {
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [transition, setTransition] = useState<TransitionRef | null>(null);
  return (
    <LiveOverlay.Provider value={overlay}>
      <div style={{ width: "760px", height: "360px", display: "flex" }}>
        <MachineCanvas graph={graph} machine="loco" viewKey="story-live" selection={selection} onSelection={setSelection} transition={transition} onTransition={setTransition}
          apply={() => {}} readOnly problems={problems} onOpenState={() => {}} />
      </div>
    </LiveOverlay.Provider>
  );
}

function Pose(props: { live: boolean }) {
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  return (
    <LiveOverlay.Provider value={props.live ? overlay : null}>
      <div style={{ width: "720px", height: "420px", display: "flex" }}>
        <PoseCanvas graph={graph} viewKey="story-live-pose" visible={null} selection={selection} onSelection={setSelection} apply={() => {}} readOnly problems={problems} onOpenMachine={() => {}} />
      </div>
    </LiveOverlay.Provider>
  );
}

const meta = { title: "Animation/Debugger/Live Overlay", render: () => <Machine /> } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const StateMachine: Story = {
  play: async ({ canvasElement }) => {
    const state = (name: string) => canvasElement.querySelector<HTMLElement>(`.ag-state[data-state="${name}"]`)!;
    expect(state("Walk").classList.contains("live-current")).toBe(true);
    expect(state("Idle").classList.contains("live-current")).toBe(false);
    expect(canvasElement.querySelectorAll(".ag-arrow.live-fading")).toHaveLength(1);
    expect(canvasElement.querySelectorAll(".ag-arrow.live-condition")).toHaveLength(1);
    expect(canvasElement.querySelectorAll(".ag-arrow.live-when")).toHaveLength(1);
    expect(canvasElement.querySelectorAll(".ag-arrow.live-shadowed")).toHaveLength(1);
    const titles = [...canvasElement.querySelectorAll(".ag-arrow title")].map((t) => t.textContent);
    expect(titles).toContain("Transition 1: Its condition is false: speed > 3 fails, because speed is 1.40.");
    expect(titles).toContain("Transition 3: Ready, but transition 1 is tried first and fires instead.");
  },
};

export const PoseNodes: Story = {
  render: () => <Pose live />,
  play: async ({ canvasElement }) => {
    const node = (id: string) => canvasElement.querySelector<HTMLElement>(`.ag-node[data-node="${id}"]`)!;
    expect(node("walk").classList.contains("live-active")).toBe(true);
    expect(node("walk").querySelector(".dbg-live-badge")?.textContent).toBe("60%");
    expect(node("walk").querySelector<HTMLElement>(".dbg-weight-fill")?.style.width).toBe("60%");
    expect(node("run").classList.contains("live-active")).toBe(false);
  },
};

/** Without a provider the canvases draw as T51 made them. */
export const NotDebugging: Story = {
  render: () => <Pose live={false} />,
  play: async ({ canvasElement }) => {
    expect(canvasElement.querySelectorAll(".live-active, .dbg-weight")).toHaveLength(0);
  },
};
