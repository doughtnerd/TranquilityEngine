// Stories (ADR 0219) for the rig stack list (ADR 0373; T51): the graph's rig nodes with what they act on; picking one is
// what shows its gizmos in the scene view (`rigGizmo.ts`, covered by the coordinator's e2e run with a skinned model).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { emptyAnimGraph, parseAnimGraph } from "../../../../engine/animation/animGraph";
import { RigEntries } from "./RigEntries";

const graph = parseAnimGraph({
  format: "myco.animgraph-source@1",
  nodes: [
    { id: "armIk", family: "rig", kind: "twoBoneIk", params: { root: "LeftUpperArm", mid: "LeftLowerArm", tip: "LeftHand" } },
    { id: "tail", family: "rig", kind: "springChain", params: { bones: ["Tail1", "Tail2", "Tail3", "Tail4"], colliderBones: ["Hips"] } },
    { id: "look", family: "rig", kind: "lookAt", params: { bones: ["Neck", "Head"], weight: 0.8 } },
  ],
}).value;

function Harness(props: { empty: boolean }) {
  const [picked, setPicked] = useState<string | null>(null);
  return <div style={{ width: "260px" }}><RigEntries graph={props.empty ? emptyAnimGraph() : graph} selected={picked} onSelect={setPicked} /></div>;
}

const meta = { title: "Animation/Graph Editor/Rig Stack", render: (args: { empty: boolean }) => <Harness {...args} />, args: { empty: false } } satisfies Meta<{ empty: boolean }>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Entries: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getAllByRole("option")).toHaveLength(3);
    await userEvent.click(c.getByText("Two Bone Ik"));
    expect(c.getAllByRole("option", { selected: true })).toHaveLength(1);
  },
};

export const NoRigNodes: Story = { args: { empty: true }, play: async ({ canvasElement }) => expect(within(canvasElement).getByText(/No rig nodes/)).toBeTruthy() };
