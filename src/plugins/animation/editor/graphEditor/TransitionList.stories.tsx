// Stories (ADR 0219) for the transition list (ADR 0373; T51): a state's transitions in priority order, reordered, opened
// to edit the condition rows, when and how, the fade shape with its preview curve and the interrupt list. A harness
// keeps the graph as the panel's document does: each accepted edit becomes the next graph (`applyEdit`).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { parseAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { applyEdit } from "../../../../editor/sdk";
import { transitionsOf } from "./machineLogic";
import { FadeShapePreview, TransitionList } from "./TransitionList";

const start = parseAnimGraph({
  format: "myco.animgraph-source@1",
  parameters: [{ name: "speed", type: "float" }, { name: "grounded", type: "bool" }],
  nodes: [{
    id: "loco", family: "logic", kind: "stateMachine", machine: {
      states: [
        { name: "Idle", root: null, transitions: [{ id: "go", to: "Move", if: { param: "speed", op: ">", value: 0.1 } }, { id: "jump", to: "Air", if: { request: "Jump" }, how: "inertialize" }] },
        { name: "Move", root: null },
        { name: "Air", root: null },
      ],
    },
  }],
}).value;

let shown: AnimGraph = start;

function Harness(props: { open: number | null }) {
  const [graph, setGraph] = useState(start);
  const [open, setOpen] = useState<number | null>(props.open);
  shown = graph;
  return (
    <div style={{ width: "340px" }}>
      <TransitionList graph={graph} machine="loco" from="Idle" open={open} onOpen={setOpen} apply={(r, l) => void applyEdit(r, l, (next) => setGraph(next), graph)} />
    </div>
  );
}

const meta = { title: "Animation/Graph Editor/Transition List", render: (args: { open: number | null }) => <Harness {...args} />, args: { open: null } } satisfies Meta<{ open: number | null }>;
export default meta;
type Story = StoryObj<typeof meta>;

const order = () => transitionsOf(shown.nodes[0]!.machine!, "Idle").map((t) => t.to);

export const Priority: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(order()).toEqual(["Move", "Air"]);
    await userEvent.click(c.getByRole("button", { name: "Raise Idle → Air" }));
    expect(order()).toEqual(["Air", "Move"]);
  },
};

export const Details: Story = {
  args: { open: 0 },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByLabelText("Fade shape of Idle → Move"), "easeOut");
    expect(transitionsOf(shown.nodes[0]!.machine!, "Idle")[0]!.shape).toBe("easeOut");
    expect(c.getByRole("img", { name: "Ease out fade" })).toBeTruthy();
    await userEvent.selectOptions(c.getByLabelText("Interrupted by (Idle → Move)"), "list");
    expect(transitionsOf(shown.nodes[0]!.machine!, "Idle")[0]!.interrupt).toEqual(["jump"]);
    await userEvent.click(c.getByRole("button", { name: "+ Condition" }));
    expect(transitionsOf(shown.nodes[0]!.machine!, "Idle")[0]!.if).toEqual({ all: [{ param: "speed", op: ">", value: 0.1 }, { param: "speed", op: ">", value: 0 }] });
  },
};

/** Each fade shape's curve (the incoming weight solid, the outgoing dashed). */
export const FadeShapes: StoryObj = {
  render: () => (
    <div style={{ display: "flex", gap: "8px" }}>
      {(["linear", "smoothstep", "easeIn", "easeOut"] as const).map((s) => <FadeShapePreview key={s} shape={s} />)}
    </div>
  ),
  play: async ({ canvasElement }) => expect(within(canvasElement).getAllByRole("img")).toHaveLength(4),
};
