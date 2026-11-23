// Stories (ADR 0219) for the linked-graph picker and slot fields (ADR 0373; T51), in a project with graphs to pick: the
// graph being edited isn't offered (it can't link itself).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, waitFor, within } from "storybook/test";
import { parseAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { applyEdit } from "../../../../editor/sdk";
import { withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";
import { LinkedGraphPicker } from "./LinkedGraphPicker";

const SELF = "animation/hero.animgraph.json";
const start = parseAnimGraph({
  format: "myco.animgraph-source@1",
  nodes: [
    { id: "weapon", family: "slots", kind: "linked", linked: { name: "Weapon", graph: "asset:animation/sword.animgraph.json" } },
    { id: "upper", family: "slots", kind: "slot", slot: { name: "UpperBody", group: "Actions" } },
  ],
}).value;

function Harness(props: { node: string }) {
  const [graph, setGraph] = useState<AnimGraph>(start);
  return <div style={{ width: "300px" }}><LinkedGraphPicker graph={graph} node={graph.nodes.find((n) => n.id === props.node)!} self={SELF} apply={(r, l) => void applyEdit(r, l, setGraph, graph)} /></div>;
}

const graphFile = { format: "myco.animgraph-source@1" };
const meta = {
  title: "Animation/Graph Editor/Linked Graph Picker",
  beforeEach: withEditor,
  parameters: { editor: { files: { [SELF]: graphFile, "animation/sword.animgraph.json": graphFile, "animation/bow.animgraph.json": graphFile } } satisfies EditorStoryParameters },
  render: (args: { node: string }) => <Harness {...args} />,
  args: { node: "weapon" },
} satisfies Meta<{ node: string }>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Linked: Story = {
  play: async ({ canvasElement }) => {
    const picker = within(canvasElement).getByLabelText("weapon default graph") as HTMLSelectElement;
    await waitFor(() => expect([...picker.options].map((o) => o.textContent).some((t) => t?.includes("bow"))).toBe(true));
    expect([...picker.options].some((o) => o.textContent?.includes("hero"))).toBe(false);
  },
};

export const Slot: Story = { args: { node: "upper" } };
