// Stories (ADR 0219) for the layers and masks panel (ADR 0373 "mask panels"; T51): layers in stacking order with the
// node each plays, its avatar mask, mode, weight and weight parameter (float parameters only), through a harness that
// keeps the graph.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { parseAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { applyEdit } from "../../../../editor/sdk";
import { LayersPanel } from "./LayersPanel";

const start = parseAnimGraph({
  format: "myco.animgraph-source@1",
  parameters: [{ name: "aim", type: "float" }, { name: "armed", type: "bool" }],
  nodes: [{ id: "upper", family: "slots", kind: "slot", slot: { name: "UpperBody" } }, { id: "base", family: "sources", kind: "clipPlayer" }],
  layers: [{ name: "UpperBody", root: "upper", mask: "asset:animation/upper.mask.json", weightParameter: "aim" }],
}).value;
let shown: AnimGraph = start;

function Harness() {
  const [graph, setGraph] = useState(start);
  shown = graph;
  return <div style={{ width: "300px" }}><LayersPanel graph={graph} apply={(r, l) => void applyEdit(r, l, setGraph, graph)} /></div>;
}

const meta = { title: "Animation/Graph Editor/Layers", render: () => <Harness /> } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Layers: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const weight = c.getByLabelText("Layer UpperBody weight parameter") as HTMLSelectElement;
    expect([...weight.options].map((o) => o.value)).toEqual(["", "aim"]);
    await userEvent.click(c.getByRole("button", { name: "+ Layer" }));
    expect(shown.layers.map((l) => l.name)).toEqual(["UpperBody", "Layer"]);
    await userEvent.selectOptions(c.getByLabelText("Layer Layer mode"), "additive");
    expect(shown.layers[1]!.mode).toBe("additive");
  },
};
