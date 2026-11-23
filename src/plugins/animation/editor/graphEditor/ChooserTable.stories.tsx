// Stories (ADR 0219) for the chooser table (ADR 0373 "the chooser table as a spreadsheet view"; T51): rows tried in
// order, each with its condition rows and the node it picks, then the fallback; reordered and added through a harness
// that keeps the graph as the panel's document does.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { parseAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { applyEdit } from "../../../../editor/sdk";
import { ChooserTable } from "./ChooserTable";

const start = parseAnimGraph({
  format: "myco.animgraph-source@1",
  parameters: [{ name: "armed", type: "bool" }, { name: "speed", type: "float" }],
  nodes: [
    { id: "pick", family: "logic", kind: "chooser", chooser: { rows: [{ if: { param: "armed", op: "==", value: true }, result: "armedIdle" }], fallback: "idle" } },
    { id: "armedIdle", family: "sources", kind: "clipPlayer", name: "Armed idle" },
    { id: "idle", family: "sources", kind: "clipPlayer", name: "Idle" },
  ],
}).value;
let shown: AnimGraph = start;

function Harness() {
  const [graph, setGraph] = useState(start);
  shown = graph;
  return <div style={{ width: "420px" }}><ChooserTable graph={graph} node={graph.nodes[0]!} apply={(r, l) => void applyEdit(r, l, setGraph, graph)} /></div>;
}

const meta = { title: "Animation/Graph Editor/Chooser Table", render: () => <Harness /> } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Rows: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "+ Row" }));
    expect(shown.nodes[0]!.chooser!.rows).toHaveLength(2);
    await userEvent.click(c.getByRole("button", { name: "Move pick row 2 up" }));
    expect(shown.nodes[0]!.chooser!.rows[1]!.result).toBe("armedIdle");
    await userEvent.selectOptions(c.getByLabelText("pick fallback"), "");
    expect(shown.nodes[0]!.chooser!.fallback).toBeNull();
  },
};
