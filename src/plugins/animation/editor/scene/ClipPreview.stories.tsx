// Stories (ADR 0219) for the clip preview (ADR 0373; T18) in the Asset Inspector: an authored clip names no model, so the
// preview asks for one to be dragged in; its play/pause button and time scrubber drive the playhead over the clip's
// length. The model side is unit-tested (`clipPreviewLogic.test.ts`). Posing a model with the clip (T18b) needs a skinned
// model and the animation core in a preview World: the headless test `posedPreview.node.test.ts` covers it through the
// runtime, and no story here drops a model in.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";
import { ClipPreview } from "./ClipPreview";

const meta = {
  title: "Animation/Clip Preview",
  beforeEach: withEditor,
  parameters: { editor: { files: { "animation/run.anim.json": { format: "myco.anim-source@1", duration: 0.8, loop: true } } } satisfies EditorStoryParameters },
  render: () => (
    <div style={{ width: "320px" }}>
      <ClipPreview path="animation/run.anim.json" />
    </div>
  ),
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** An authored clip with no model yet: a drop zone for one, and the controls over its 0.8 s. */
export const AuthoredClip: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByText("0.00 s / 0.80 s")).toBeTruthy());
    expect(c.getByText("Drag a model here to preview the clip on it")).toBeTruthy();
    await step("Play starts the playhead; Pause stops it", async () => {
      await userEvent.click(c.getByRole("button", { name: "Play" }));
      await waitFor(() => expect(c.getByRole("button", { name: "Pause" })).toHaveAttribute("aria-pressed", "true"));
      await userEvent.click(c.getByRole("button", { name: "Pause" }));
      expect(c.getByRole("button", { name: "Play" })).toHaveAttribute("aria-pressed", "false");
    });
  },
};
