// Stories (ADR 0219) for the Inspector's summary of a selected animation graph (T51): what it holds, its problems, and
// Open in Animation Graph.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { editor } from "../../../../editor/sdk";
import { withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";
import { AnimGraphSummary } from "./AnimGraphSummary";
import { ANIM_GRAPH_PANEL } from "./panelId";

const GRAPH = "animation/loco.animgraph.json";
const meta = {
  title: "Animation/Graph Editor/Summary",
  beforeEach: withEditor,
  parameters: {
    editor: {
      files: {
        [GRAPH]: {
          format: "myco.animgraph-source@1",
          output: "loco",
          parameters: [{ name: "speed", type: "float" }],
          nodes: [{ id: "loco", family: "logic", kind: "stateMachine", machine: { states: [{ name: "Idle", root: null }, { name: "Move", root: null }] } }],
        },
      },
    } satisfies EditorStoryParameters,
  },
  render: () => <div style={{ width: "280px" }}><AnimGraphSummary path={GRAPH} /></div>,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Summary: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByText("1 (2 states)")).toBeTruthy());
    await userEvent.click(c.getByRole("button", { name: "Open in Animation Graph" }));
    expect(editor.assets.openIn(ANIM_GRAPH_PANEL)).toBe(GRAPH);
  },
};
