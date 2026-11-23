// Stories (ADR 0219) for the Animator's clip drop zone (ADR 0373 "Drop behaviour"; T18) under its card in the shell's
// Inspector: with no graph it invites a clip; with a graph it's there too, and a dropped clip is refused with the reason.
// The drop itself is pointer-driven through the asset drag (covered by `clipDrop.test.ts` through the same contribution
// the Hierarchy asks, and by the coordinator's e2e run).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, waitFor, within } from "storybook/test";
import { editor } from "../../../../editor/sdk";
import { PanelStory, withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";

const scene = {
  format: "myco.scene@4",
  nodes: [
    { id: "hero", name: "Hero", components: [{ type: "engine.Transform", data: {} }, { type: "engine.Animator", data: {} }] },
    { id: "graphed", name: "Graphed", components: [{ type: "engine.Transform", data: {} }, { type: "engine.Animator", data: { graph: "asset:animation/loco.animgraph.json" } }] },
  ],
};

const meta = {
  title: "Animation/Animator Clip Drop",
  beforeEach: withEditor,
  parameters: { editor: { files: { "scenes/main.scene.json": scene, "animation/run.anim.json": { format: "myco.anim-source@1", duration: 0.8 } }, scene: "scenes/main.scene.json" } satisfies EditorStoryParameters },
  render: () => <PanelStory id="inspector" />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** An Animator without a graph: the zone under its fields invites a clip. */
export const WithoutAGraph: Story = {
  play: async ({ canvasElement }) => {
    editor.scene.selection.set(["hero"]);
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByText("Drop a clip here to play it on start")).toBeTruthy(), { timeout: 30000 });
  },
};

/** An Animator with a graph: the zone is there; a dropped clip is refused (adding a state is the graph editor's). */
export const WithAGraph: Story = {
  play: async ({ canvasElement }) => {
    editor.scene.selection.set(["graphed"]);
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByLabelText("Drop a clip here")).toBeTruthy(), { timeout: 30000 });
  },
};
