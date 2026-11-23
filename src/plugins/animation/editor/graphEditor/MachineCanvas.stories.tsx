// Stories (ADR 0219) for a state machine's canvas (ADR 0373; T51) on its own: states, Entry wired to the entry state,
// Any State, and transitions drawn with their priority numbers ("A1" for any-state ones). Wiring a transition by drag
// is pointer-driven through xyflow; it's covered in the panel story's list and the coordinator's e2e run.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { parseAnimGraph } from "../../../../engine/animation/animGraph";
import { applyEdit } from "../../../../editor/sdk";
import { MachineCanvas } from "./MachineCanvas";
import type { TransitionRef } from "./machineLogic";
import { indexProblems } from "./problemLogic";
import "../../../../editor/graph/graph.css";
import "./animGraphEditor.css";

const start = parseAnimGraph({
  format: "myco.animgraph-source@1",
  output: "loco",
  nodes: [{
    id: "loco", family: "logic", kind: "stateMachine", machine: {
      entry: "Idle",
      states: [
        { name: "Idle", root: null, position: [220, 40], transitions: [{ to: "Walk" }, { to: "Run" }] },
        { name: "Walk", root: null, position: [460, 40], transitions: [{ to: "Idle" }] },
        { name: "Run", root: null, position: [460, 160], exit: true },
      ],
      anyState: [{ to: "Idle", how: "cut" }],
    },
  }],
}).value;

function Harness() {
  const [graph, setGraph] = useState(start);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [transition, setTransition] = useState<TransitionRef | null>(null);
  return (
    <div style={{ width: "760px", height: "360px", display: "flex" }}>
      <MachineCanvas graph={graph} machine="loco" viewKey="story" selection={selection} onSelection={setSelection} transition={transition} onTransition={setTransition}
        apply={(r, l) => void applyEdit(r, l, setGraph, graph)} readOnly={false} problems={indexProblems(graph, [])} onOpenState={() => {}} />
      <output aria-label="Open transition">{transition ? `${transition.from ?? "any"}/${transition.index}` : "none"}</output>
    </div>
  );
}

const meta = { title: "Animation/Graph Editor/State Machine Canvas", render: () => <Harness /> } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Machine: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(canvasElement.querySelectorAll(".ag-state-state")).toHaveLength(3);
    expect(c.getAllByRole("button", { name: /^Transition / }).map((b) => b.textContent)).toEqual(["A1", "1", "2", "1"]);
    await userEvent.click(c.getAllByRole("button", { name: "Transition 2" })[0]!);
    expect(c.getByLabelText("Open transition").textContent).toBe("Idle/1");
  },
};
