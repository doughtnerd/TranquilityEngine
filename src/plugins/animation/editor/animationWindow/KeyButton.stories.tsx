// Stories (ADR 0219, 0235) for the Inspector's key buttons (ADR 0373), the Animation plugin's field adornment: with the
// Animation window open on the Animator above the selected node, each animatable field shows a diamond, filled where a
// key lies at the playhead; clicking it adds or removes that key (one undo step on the clip). With the window closed
// there are none. The rules are unit-tested (`animationWindowLogic.test.ts`).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { editor } from "../../../../editor/sdk";
import { PanelStory, withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";
import { ANIMATION_WINDOW_PANEL } from "./panelId";

const SCENE = "scenes/level.scene.json";
const CLIP = "animation/run.anim.json";
const scene = {
  format: "myco.scene@4",
  nodes: [
    { id: "hero", name: "Hero", components: [{ type: "engine.Transform", data: {} }, { type: "engine.Animator", data: { defaultClip: `asset:${CLIP}` } }] },
    { id: "lamp", name: "Lamp", parent: "hero", components: [{ type: "engine.Transform", data: {} }, { type: "engine.Light", data: { type: "point" } }] },
  ],
};
const clip = { format: "myco.anim-source@1", duration: 1, tracks: [{ kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, curves: [[[0, 1], [0.5, 3]]] }] };

const meta = {
  title: "Animation/Animation Window/Key Buttons",
  beforeEach: withEditor,
  parameters: { editor: { files: { [SCENE]: scene, [CLIP]: clip }, scene: SCENE } satisfies EditorStoryParameters },
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
      <PanelStory id={ANIMATION_WINDOW_PANEL} height={420} />
      <PanelStory id="inspector" height={420} />
    </div>
  ),
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Filled at a key (the playhead starts at 0, where intensity has one), empty elsewhere; clicking adds the key. */
export const AddAndRemove: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    editor.scene.selection.set(["lamp"]);
    const intensity = await c.findByRole("button", { name: "Remove key: intensity" }, { timeout: 30000 });
    expect(intensity).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(c.getByRole("button", { name: "Add key: range" }));
    await waitFor(() => expect(c.getByRole("button", { name: "Remove key: range" })).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(c.getByRole("button", { name: "Remove key: range" }));
    await waitFor(() => expect(c.getByRole("button", { name: "Add key: range" })).toHaveAttribute("aria-pressed", "false"));
    // A field with choices is animatable too (a discrete enum track).
    expect(c.getByRole("button", { name: "Add key: type" })).toBeTruthy();
  },
};

/** Without the window, the Inspector shows no key buttons. */
export const WindowClosed: Story = {
  render: () => <PanelStory id="inspector" height={420} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    editor.scene.selection.set(["lamp"]);
    await c.findByText(/^intensity$/i, {}, { timeout: 30000 });
    expect(c.queryByRole("button", { name: /key: intensity$/ })).toBeNull();
  },
};
