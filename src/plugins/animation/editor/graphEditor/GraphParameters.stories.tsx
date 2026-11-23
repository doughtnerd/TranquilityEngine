// Stories (ADR 0219) for the graph's parameters panel (ADR 0373, 0304; T51): the SDK's parameter cards over the graph's
// list, each with the graph's own fields (type, typed default, flags) and where it is used; refusals (a parameter a
// condition compares can't be removed) go to the status bar, read through a spy on `editor.messages.error`.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, spyOn, userEvent, within } from "storybook/test";
import { parseAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { applyEdit, editor } from "../../../../editor/sdk";
import { GraphParameters } from "./GraphParameters";

const start = parseAnimGraph({
  format: "myco.animgraph-source@1",
  parameters: [{ name: "speed", type: "float" }, { name: "grounded", type: "bool", default: true, replicate: true }],
  nodes: [
    { id: "move", family: "sources", kind: "blendSpace1D", params: { x: "speed" } },
    { id: "loco", family: "logic", kind: "stateMachine", machine: { states: [{ name: "Idle", root: null, transitions: [{ to: "Air", if: { param: "grounded", op: "==", value: false } }] }, { name: "Air", root: null }] } },
  ],
}).value;
let shown: AnimGraph = start;

function Harness() {
  const [graph, setGraph] = useState(start);
  shown = graph;
  return <div style={{ width: "300px" }}><GraphParameters graph={graph} apply={(r, l) => void applyEdit(r, l, setGraph, graph)} /></div>;
}

const meta = { title: "Animation/Graph Editor/Parameters", render: () => <Harness /> } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Parameters: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText("Used by move.x")).toBeTruthy();
    await userEvent.click(c.getByRole("button", { name: "+ Parameter" }));
    expect(shown.parameters.map((p) => p.name)).toEqual(["speed", "grounded", "Parameter"]);
    await userEvent.selectOptions(c.getByLabelText("Parameter type"), "int");
    expect(shown.parameters[2]!.type).toBe("int");
    const errors = spyOn(editor.messages, "error");
    await userEvent.click(c.getByRole("button", { name: "Remove parameter grounded" }));
    expect(errors.mock.calls.at(-1)?.[0]).toBe("Can't remove parameter grounded: 1 condition compares it; remove that row first");
    errors.mockRestore();
  },
};
