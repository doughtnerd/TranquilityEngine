// Stories (ADR 0219) for the blend-space editor (ADR 0373; T51): a 1D track and a 2D plot with the core's triangulation,
// the samples with their weights at the preview point (the runtime's rule), and sample edits through a harness that keeps
// the graph as the panel's document does.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fireEvent, within } from "storybook/test";
import { parseAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { applyEdit } from "../../../../editor/sdk";
import { BlendSpaceEditor } from "./BlendSpaceEditor";
import type { Point2 } from "./blendSpaceGeometry";

const graphOf = (kind: "blendSpace1D" | "blendSpace2D", coords: number[]) => parseAnimGraph({
  format: "myco.animgraph-source@1",
  nodes: [
    { id: "space", family: "sources", kind, inputs: ["idle", "walk", "run"], params: { coords } },
    { id: "idle", family: "sources", kind: "clipPlayer", name: "Idle" },
    { id: "walk", family: "sources", kind: "clipPlayer", name: "Walk" },
    { id: "run", family: "sources", kind: "clipPlayer", name: "Run" },
  ],
}).value;

let shown: AnimGraph | null = null;

function Harness(props: { kind: "blendSpace1D" | "blendSpace2D"; coords: number[]; preview: Point2 }) {
  const [graph, setGraph] = useState(() => graphOf(props.kind, props.coords));
  shown = graph;
  return <div style={{ width: "320px" }}><BlendSpaceEditor graph={graph} node={graph.nodes[0]!} preview={props.preview} apply={(r, l) => void applyEdit(r, l, setGraph, graph)} /></div>;
}

type Args = { kind: "blendSpace1D" | "blendSpace2D"; coords: number[]; preview: Point2 };
const meta = { title: "Animation/Graph Editor/Blend Space", render: (args: Args) => <Harness {...args} /> } satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Track1D: Story = {
  args: { kind: "blendSpace1D", coords: [0, 1.5, 4], preview: [0.75, 0] },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByLabelText("Idle weight").textContent).toBe("0.50");
    expect(c.getByLabelText("Walk weight").textContent).toBe("0.50");
    fireEvent.change(c.getByLabelText("Run x"), { target: { value: "3" } });
    expect(shown!.nodes[0]!.params.coords).toEqual([0, 1.5, 3]);
  },
};

export const Plot2D: Story = {
  args: { kind: "blendSpace2D", coords: [0, 0, 2, 0, 0, 2], preview: [0.5, 0.5] },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(canvasElement.querySelectorAll(".ag-plot-tri")).toHaveLength(1);
    expect(c.getByLabelText("Idle weight").textContent).toBe("0.50");
    expect(c.getByLabelText("Walk weight").textContent).toBe("0.25");
    // A sample moved onto another's point is refused (the core would give it no weight).
    fireEvent.change(c.getByLabelText("Run y"), { target: { value: "0" } });
    fireEvent.change(c.getByLabelText("Run x"), { target: { value: "2" } });
    expect(shown!.nodes[0]!.params.coords).toEqual([0, 0, 2, 0, 0, 0]);
  },
};
