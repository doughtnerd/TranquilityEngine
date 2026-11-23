// Stories (ADR 0219, 0235) for the Animation window (ADR 0373) as the dock renders it, over a scene open in a headless
// Editor World: nothing to animate, the window bound to the selected node's Animator and its default clip (rows by
// node, component and field, keys as diamonds), selecting and deleting a key, adding a property track, the record and
// preview toggles (the Inspector's key buttons are `KeyButton.stories.tsx`). The edit rules are unit-tested
// (`animationWindowLogic.test.ts`, `animationSession.test.ts`).
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
    { id: "crate", name: "Crate", components: [{ type: "engine.Transform", data: {} }] },
  ],
};
const clip = {
  format: "myco.anim-source@1",
  duration: 1,
  tracks: [
    { kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, curves: [[[0, 1], [0.5, 3]]] },
    { kind: "marker", keys: [{ time: 0, kind: "sync", name: "L" }] },
  ],
};

const meta = {
  title: "Animation/Animation Window",
  beforeEach: withEditor,
  parameters: { editor: { files: { [SCENE]: scene, [CLIP]: clip }, scene: SCENE } satisfies EditorStoryParameters },
  render: () => <PanelStory id={ANIMATION_WINDOW_PANEL} height={420} />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const shows = (canvasElement: HTMLElement, text: string | RegExp) => within(canvasElement).findByText(text, {}, { timeout: 30000 });

/** Nothing selected and no clip opened: how to bind the window. */
export const NothingToAnimate: Story = {
  play: async ({ canvasElement }) => {
    await shows(canvasElement, "Nothing to animate");
  },
};

/** A node under an Animator: the Animator's default clip, its rows and keys; a key selected and deleted. */
export const BoundToAnimator: Story = {
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    editor.scene.selection.set(["lamp"]);
    await shows(canvasElement, "intensity");
    expect(c.getByRole("button", { name: "Markers" })).toBeTruthy();
    expect(c.getByRole("combobox", { name: "Clip" })).toHaveDisplayValue(/Default clip \(run\.anim\.json\)/);
    await step("Click a key to select it; Delete removes it as one undo step", async () => {
      const key = c.getByRole("button", { name: /intensity key at 0\.50 s/ });
      await userEvent.click(key);
      expect(key).toHaveAttribute("aria-pressed", "true");
      expect(c.getByText("1 key selected")).toBeTruthy();
      await userEvent.click(c.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(c.queryByRole("button", { name: /intensity key at 0\.50 s/ })).toBeNull());
    });
  },
};

/** Add Property lists the animatable fields under the Animator the clip doesn't animate; picking one adds its row. */
export const AddProperty: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    editor.scene.selection.set(["hero"]);
    await shows(canvasElement, "intensity");
    await userEvent.selectOptions(c.getByRole("combobox", { name: "Add property" }), "Lamp › Light.range");
    await shows(canvasElement, "range");
  },
};

/** Record turns the preview on with it; turning the preview off turns recording off. */
export const RecordAndPreview: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    editor.scene.selection.set(["lamp"]);
    await shows(canvasElement, "intensity");
    await userEvent.click(c.getByRole("button", { name: "● Record" }));
    expect(c.getByRole("button", { name: "● Record" })).toHaveAttribute("aria-pressed", "true");
    expect(c.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(c.getByRole("button", { name: "Preview" }));
    expect(c.getByRole("button", { name: "● Record" })).toHaveAttribute("aria-pressed", "false");
  },
};

