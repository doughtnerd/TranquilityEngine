// Stories (ADR 0219) for a Skeleton's bones (ADR 0373; T18) in the shell's own panels: the Hierarchy lists the skeleton
// asset's bones under the node with the Skeleton (each closed until opened), selecting one makes the Inspector show the
// bone (name, parent, rest and current pose), and Add BoneAttachment adds a child following it. The rules are unit tests
// (`bones.test.ts`); these show the views. The skeleton is the core's fixture `runtime/wasm/fixtures/small.skel`.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { editor } from "../../../../editor/sdk";
import { PanelStory, withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";

const SKEL_URL = new URL("../../runtime/wasm/fixtures/small.skel", import.meta.url).href;

const scene = {
  format: "myco.scene@4",
  nodes: [{ id: "rig", name: "Rig", components: [{ type: "engine.Transform", data: {} }, { type: "engine.Skeleton", data: { skeleton: "asset:rigs/small.skel" } }] }],
};

const editorParameters = { files: { "scenes/main.scene.json": scene }, scene: "scenes/main.scene.json" } satisfies EditorStoryParameters;

const meta = {
  title: "Animation/Bones",
  // The skeleton's bytes are fetched first, then written into the story's project with the scene.
  beforeEach: async () => {
    const bytes = new Uint8Array(await (await fetch(SKEL_URL)).arrayBuffer());
    return withEditor({ parameters: { editor: { ...editorParameters, files: { ...editorParameters.files, "rigs/small.skel": bytes } } } });
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The Hierarchy: the root bone under Rig, closed; opening it shows its children. */
export const InTheHierarchy: Story = {
  render: () => <PanelStory id="hierarchy" />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const root = await waitFor(() => c.getByText("bone0"), { timeout: 30000 });
    expect(c.queryByText("bone1")).toBeNull();
    await userEvent.click(root);
    await waitFor(() => expect(editor.scene.selection.keys).toEqual([])); // a bone isn't a node
  },
};

/** The Inspector showing a selected bone, with Add BoneAttachment. */
export const InTheInspector: Story = {
  render: () => <PanelStory id="inspector" />,
  play: async ({ canvasElement, step }) => {
    const c = within(canvasElement);
    editor.scene.selection.setBone(["rig"], "bone3", "myco.animation.bones");
    await waitFor(() => expect(c.getByText("bone3")).toBeTruthy(), { timeout: 30000 });
    expect(c.getByText("bone2")).toBeTruthy(); // its parent
    await step("Add BoneAttachment adds a child following the bone and selects it", async () => {
      await userEvent.click(c.getByRole("button", { name: "Add BoneAttachment" }));
      await waitFor(() => expect(editor.scene.selection.keys).toHaveLength(1));
    });
  },
};
