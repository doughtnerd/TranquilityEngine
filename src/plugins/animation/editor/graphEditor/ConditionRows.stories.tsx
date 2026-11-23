// Stories (ADR 0219) for the condition rows editor (ADR 0373; T51): rows of parameter, operator and value joined by all
// or any, typed against the graph's parameters (a bool offers == and != with true/false). A harness keeps the condition
// as its owner does; a refusal goes to the status bar (`applyEdit`).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { emptyAnimGraph, type AnimGraph, type Condition } from "../../../../engine/animation/animGraph";
import { applyEdit } from "../../../../editor/sdk";
import { ConditionRows } from "./ConditionRows";

const graph: AnimGraph = {
  ...emptyAnimGraph(),
  parameters: [
    { name: "speed", type: "float", default: 0, replicate: false, predicted: false, computed: false },
    { name: "grounded", type: "bool", default: true, replicate: false, predicted: false, computed: false },
  ],
};
let shown: Condition | null = null;

function Harness(props: { start: Condition | null }) {
  const [c, setC] = useState(props.start);
  shown = c;
  return <div style={{ width: "360px" }}><ConditionRows graph={graph} condition={c} label="Idle → Move" apply={(r, l) => void applyEdit(r, l, setC, c)} /></div>;
}

const meta = { title: "Animation/Graph Editor/Condition Rows", render: (args: { start: Condition | null }) => <Harness {...args} />, args: { start: null } } satisfies Meta<{ start: Condition | null }>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText("Always")).toBeTruthy();
    await userEvent.click(c.getByRole("button", { name: "+ Condition" }));
    expect(shown).toEqual({ param: "speed", op: ">", value: 0 });
  },
};

export const TypedRows: Story = {
  args: { start: { all: [{ param: "speed", op: ">", value: 0.1 }, { param: "grounded", op: "==", value: true }] } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const ops = c.getByLabelText("Condition 2 operator of Idle → Move") as HTMLSelectElement;
    expect([...ops.options].map((o) => o.value)).toEqual(["==", "!="]);
    await userEvent.selectOptions(c.getByLabelText("Join of Idle → Move"), "any");
    expect(shown).toEqual({ any: [{ param: "speed", op: ">", value: 0.1 }, { param: "grounded", op: "==", value: true }] });
    await userEvent.selectOptions(c.getByLabelText("Condition 2 value of Idle → Move"), "false");
    expect((shown as { any: Condition[] }).any[1]).toEqual({ param: "grounded", op: "==", value: false });
  },
};

export const Request: Story = {
  args: { start: { request: "Jump", op: "==", value: true } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByLabelText("Condition 1 value of Idle → Move"), "false");
    expect(shown).toEqual({ request: "Jump", op: "==", value: false });
  },
};
