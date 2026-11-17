// Stories (ADR 0219, 0235) for the Physics plugin's Edit Collider header action (ADR 0142), in the shell's own Inspector
// as the plugin registers it: it makes the collider tool the scene view's active tool in that collider's mode through
// `editor.viewport` (ADR 0231), shows when it is on, is ignored while playing, steps aside for another collider, and
// ends when its collider is removed. The tool's handles (drags, undo steps) are unit tests of the gizmo
// (collider2d.test.ts, collider3d.test.ts), which run the tool host on a scene view.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { editor } from "../../../editor/sdk";
import { PanelStory, setPlayState, withEditor, type EditorStoryParameters } from "../../../editor/stories/editorStory";
import { COLLIDER_TOOL_ID, type EditingCollider } from "./colliderGizmo";

/** A node with two colliders, and one without. */
const scene = {
  format: "myco.scene@4",
  settings: { physics: "3d" },
  nodes: [
    {
      id: "crate",
      name: "Crate",
      components: [
        { type: "engine.Transform", data: { position: [0, 0, 0] } },
        { type: "engine.BoxCollider", data: { size: [1, 1, 1] } },
        { type: "engine.SphereCollider", data: { radius: 0.5 } },
      ],
    },
    { id: "empty", name: "Empty", components: [{ type: "engine.Transform", data: {} }] },
  ],
};

const meta = {
  title: "Physics/Edit Collider",
  beforeEach: withEditor,
  parameters: { editor: { files: { "scenes/main.scene.json": scene }, scene: "scenes/main.scene.json" } satisfies EditorStoryParameters },
  render: () => <PanelStory id="inspector" />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const mode = () => editor.viewport.mode<EditingCollider>(COLLIDER_TOOL_ID).peek();

/** Select the crate and wait for its two Edit Collider buttons (box first, as in the file). */
async function crateButtons(canvasElement: HTMLElement) {
  editor.scene.selection.set(["crate"]);
  const c = within(canvasElement);
  await waitFor(() => expect(c.getAllByRole("button", { name: "Edit Collider" })).toHaveLength(2), { timeout: 30000 });
  return () => c.getAllByRole("button", { name: "Edit Collider" }) as [HTMLButtonElement, HTMLButtonElement];
}

export const ToggleEditing: Story = {
  play: async ({ canvasElement, step }) => {
    const buttons = await crateButtons(canvasElement);
    expect(editor.viewport.activeTool).toBeNull();
    await step("pressing it makes the collider tool active in that collider's mode", async () => {
      await userEvent.click(buttons()[0]);
      expect(editor.viewport.activeTool).toBe(COLLIDER_TOOL_ID);
      expect(mode()).toEqual({ key: "crate", type: "engine.BoxCollider", index: 0 });
      await waitFor(() => expect(buttons()[0]).toHaveAttribute("aria-pressed", "true"));
      expect(buttons()[1]).toHaveAttribute("aria-pressed", "false");
    });
    await step("another collider's button moves the handles to it", async () => {
      await userEvent.click(buttons()[1]);
      expect(mode()).toEqual({ key: "crate", type: "engine.SphereCollider", index: 0 });
      await waitFor(() => expect(buttons()[1]).toHaveAttribute("aria-pressed", "true"));
      expect(buttons()[0]).toHaveAttribute("aria-pressed", "false");
    });
    await step("pressing it again gives the scene view back to the transform tools", async () => {
      await userEvent.click(buttons()[1]);
      expect(editor.viewport.activeTool).toBeNull();
      expect(mode()).toBeNull();
      await waitFor(() => expect(buttons()[1]).toHaveAttribute("aria-pressed", "false"));
    });
  },
};

export const IgnoredWhilePlaying: Story = {
  play: async ({ canvasElement }) => {
    const buttons = await crateButtons(canvasElement);
    setPlayState("playing");
    await userEvent.click(buttons()[0]);
    expect(editor.viewport.activeTool).toBeNull();
    expect(buttons()[0]).toHaveAttribute("aria-pressed", "false");
  },
};

export const RemovingTheColliderEndsEditing: Story = {
  play: async ({ canvasElement }) => {
    const buttons = await crateButtons(canvasElement);
    await userEvent.click(buttons()[0]);
    expect(editor.viewport.activeTool).toBe(COLLIDER_TOOL_ID);
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Remove BoxCollider" }));
    expect(editor.viewport.activeTool).toBeNull();
    await waitFor(() => expect(within(canvasElement).getAllByRole("button", { name: "Edit Collider" })).toHaveLength(1));
    expect(editor.scene.open!.doc.components("crate").map((c) => c.type)).toEqual(["engine.Transform", "engine.SphereCollider"]);
  },
};

export const NoCollider: Story = {
  play: async ({ canvasElement }) => {
    editor.scene.selection.set(["empty"]);
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByRole("textbox", { name: "Name" })).toHaveValue("Empty"), { timeout: 30000 });
    expect(c.queryByRole("button", { name: "Edit Collider" })).toBeNull();
  },
};
