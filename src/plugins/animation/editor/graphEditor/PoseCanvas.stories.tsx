// Stories (ADR 0219) for the pose-node canvas (ADR 0373; T51) on its own: nodes with their pose pins and wires, the
// compiler's problems as badges, selection and Delete, and the node search over the catalogue (Space).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { parseAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { compileAnimGraph } from "../../../../engine/animation/graphCompile";
import { applyEdit } from "../../../../editor/sdk";
import { PoseCanvas } from "./PoseCanvas";
import { indexProblems } from "./problemLogic";
import "../../../../editor/graph/graph.css";
import "./animGraphEditor.css";

const start = parseAnimGraph({
  format: "myco.animgraph-source@1",
  output: "mix",
  nodes: [
    { id: "walk", family: "sources", kind: "clipPlayer", position: [0, 0] },
    { id: "run", family: "sources", kind: "clipPlayer", position: [0, 140] },
    { id: "mix", family: "mixing", kind: "blend2", position: [260, 60], inputs: ["walk", "run"] },
    { id: "space", family: "sources", kind: "blendSpace1D", position: [260, 240], inputs: ["walk"], params: { coords: [0, 1, 2] } },
  ],
}).value;
let shown: AnimGraph = start;

function Harness() {
  const [graph, setGraph] = useState(start);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  shown = graph;
  return (
    <div style={{ width: "720px", height: "420px", display: "flex" }}>
      <PoseCanvas graph={graph} viewKey="story" visible={null} selection={selection} onSelection={setSelection} apply={(r, l) => void applyEdit(r, l, setGraph, graph)}
        readOnly={false} problems={indexProblems(graph, compileAnimGraph(graph).problems)} onOpenMachine={() => {}} />
    </div>
  );
}

const meta = { title: "Animation/Graph Editor/Pose Canvas", render: () => <Harness /> } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Nodes: Story = {
  play: async ({ canvasElement, step }) => {
    const node = (id: string) => canvasElement.querySelector<HTMLElement>(`.ag-node[data-node="${id}"]`)!;
    await step("wires and problems show", async () => {
      expect(canvasElement.querySelectorAll(".ag-wire")).toHaveLength(3);
      expect(node("space").querySelector(".ag-badge.error, .ag-badge.warning")).not.toBeNull();
    });
    await step("Space opens the node search; picking adds the node", async () => {
      await userEvent.click(node("walk").querySelector(".ag-node-head")!);
      await userEvent.keyboard(" ");
      const search = await within(canvasElement).findByRole("dialog", { name: "Add node" });
      await userEvent.type(within(search).getByRole("searchbox"), "inertialize{Enter}");
      await waitFor(() => expect(shown.nodes.map((n) => n.id)).toContain("inertialize"));
    });
    await step("Delete removes the selected node and its wires", async () => {
      await userEvent.click(node("run").querySelector(".ag-node-head")!);
      await userEvent.keyboard("{Delete}");
      await waitFor(() => expect(shown.nodes.find((n) => n.id === "mix")!.inputs).toEqual(["walk"]));
    });
  },
};
