// Stories (ADR 0219) for a node's card (ADR 0373 "Node cards generated from the node catalogue's schema"; T51): fields
// typed by each kind's schema (numbers with units, enums, vectors, parameter bindings filtered by type, asset pickers,
// lists), the compiler's problems under their field, and a third-party node's card from the same schema. A harness keeps
// the graph; a refused value goes to the status bar.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fireEvent, userEvent, within } from "storybook/test";
import { parseAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { compileAnimGraph } from "../../../../engine/animation/graphCompile";
import { applyEdit } from "../../../../editor/sdk";
import { NodeCard } from "./NodeCard";
import { indexProblems } from "./problemLogic";

const start = parseAnimGraph({
  format: "myco.animgraph-source@1",
  output: "move",
  parameters: [{ name: "speed", type: "float" }, { name: "grounded", type: "bool" }],
  nodes: [
    { id: "move", family: "sources", kind: "blendSpace1D", inputs: ["walk"], params: { x: "speed", coords: [0, 1] } },
    { id: "walk", family: "sources", kind: "clipPlayer", params: { speed: 1.5 } },
    { id: "spring", family: "rig", kind: "springChain", inputs: ["walk"], params: { bones: ["Tail1", "Tail2"] } },
    { id: "custom", family: "plugin", kind: "plugin", params: { nodeKind: 2 } },
  ],
}).value;
let shown: AnimGraph = start;

function Harness(props: { node: string }) {
  const [graph, setGraph] = useState(start);
  shown = graph;
  const problems = indexProblems(graph, compileAnimGraph(graph).problems);
  const node = graph.nodes.find((n) => n.id === props.node)!;
  return (
    <div style={{ width: "320px" }}>
      <NodeCard graph={graph} node={node} apply={(r, l) => void applyEdit(r, l, setGraph, graph)} problems={(f) => (f ? problems.byField.get(`${node.id}/${f}`) ?? [] : [])} />
    </div>
  );
}

const meta = { title: "Animation/Graph Editor/Node Card", render: (args: { node: string }) => <Harness {...args} />, args: { node: "walk" } } satisfies Meta<{ node: string }>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ClipPlayer: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText("Speed")).toBeTruthy();
    await userEvent.selectOptions(c.getByLabelText("walk loop"), "once");
    expect(shown.nodes[1]!.params.loop).toBe("once");
    // Out of range: refused, nothing changes.
    fireEvent.change(c.getByLabelText("walk start"), { target: { value: "-1" } });
    expect(shown.nodes[1]!.params.start).toBeUndefined();
  },
};

/** A parameter binding offers only parameters of the types it takes. */
export const BlendSpaceBinding: Story = {
  args: { node: "move" },
  play: async ({ canvasElement }) => {
    const x = within(canvasElement).getByLabelText("move x") as HTMLSelectElement;
    expect([...x.options].map((o) => o.value)).toEqual(["", "speed"]);
  },
};

export const SpringChain: Story = { args: { node: "spring" } };

/** A third-party node: its card comes from the same schema. */
export const ThirdParty: Story = {
  args: { node: "custom" },
  play: async ({ canvasElement }) => expect(within(canvasElement).getByLabelText("custom nodeKind")).toBeTruthy(),
};
