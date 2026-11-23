// Stories (ADR 0219) for the bone map editor and the retarget card (ADR 0373; T54): cards of a model's Import Settings in the
// shell's Inspector, so Apply and Revert are the shell's. The rules are unit tests (`boneMapLogic.test.ts`,
// `retargetLogic.test.ts`); these show the views and the file Apply writes. The model is the importer tests' skinned glTF
// (six joints: Hips, Spine, Chest, Neck, Head, Jaw; clips Walk, Wave, Bounce).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { editor } from "../../../../editor/sdk";
import { PanelStory, fileJson, withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";
import { skinnedGltf } from "../../../../engine/tests/fixtures/gltf/skinnedGltf";

const HERO = "models/hero.gltf";
const ROBOT = "models/robot.gltf";
const files = { [HERO]: skinnedGltf(), [ROBOT]: skinnedGltf(), "rigs/biped.skelprofile.json": { format: "myco.skelprofile@1", name: "Biped", roles: [{ name: "Hips", required: true }, { name: "Head" }], chains: [] } };

const meta = {
  title: "Animation/Bone map",
  beforeEach: withEditor,
  parameters: { editor: { files } satisfies EditorStoryParameters },
  render: () => <PanelStory id="inspector" />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const open = async (canvasElement: HTMLElement) => {
  editor.assets.reveal(HERO);
  const c = within(canvasElement);
  await c.findByRole("table", { name: "Bone map" }, { timeout: 60000 });
  return c;
};

/** The table lists the Humanoid's roles; mapping a role to a bone and applying writes `animation.boneMap` to the sidecar. */
export const MapABone: Story = {
  play: async ({ canvasElement }) => {
    const c = await open(canvasElement);
    expect(c.getByText(/of 64 mapped/)).toBeTruthy();
    await userEvent.selectOptions(c.getByLabelText("Bone for Chest"), "Neck");
    await userEvent.click(c.getByRole("button", { name: "Apply" }));
    // A map the importer guessed is kept by the first edit, so the sidecar holds it too.
    await waitFor(async () => expect((await fileJson<{ animation: { boneMap: Record<string, string> } }>(`${HERO}.meta.json`)).animation.boneMap).toMatchObject({ Chest: "Neck" }));
  },
};

/** Another profile changes the roles listed; the required roles without a bone are named. */
export const CustomProfile: Story = {
  play: async ({ canvasElement }) => {
    const c = await open(canvasElement);
    await userEvent.selectOptions(c.getByLabelText("Skeleton profile"), "asset:rigs/biped.skelprofile.json");
    await waitFor(() => expect(c.getByLabelText("Bone for Head")).toBeTruthy());
    expect(c.queryByLabelText("Bone for LeftHand")).toBeNull();
    await userEvent.selectOptions(c.getByLabelText("Bone for Head"), "Head");
    await waitFor(() => expect(c.getByText(/Required without a bone: Hips/)).toBeTruthy());
  },
};

/** Revert drops what was mapped; the shell's own buttons. */
export const Revert: Story = {
  play: async ({ canvasElement }) => {
    const c = await open(canvasElement);
    const chest = () => c.getByLabelText("Bone for Chest") as HTMLSelectElement;
    const before = chest().value;
    await userEvent.selectOptions(chest(), before === "Neck" ? "Head" : "Neck");
    await waitFor(() => expect(chest().value).not.toBe(before));
    await userEvent.click(c.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(chest().value).toBe(before));
  },
};

/** The retarget card: with no source the bake says what to choose; a source model offers its clips. */
export const Retarget: Story = {
  play: async ({ canvasElement }) => {
    const c = await open(canvasElement);
    const bake = await c.findByRole("button", { name: "Bake retargeted clip" });
    expect((bake as HTMLButtonElement).disabled).toBe(true);
    expect(bake.getAttribute("title")).toMatch(/Choose the model/);
    await userEvent.selectOptions(c.getByLabelText("Source model"), ROBOT);
    const clips = await c.findByLabelText("Source clip");
    await waitFor(() => expect(within(clips).getByRole("option", { name: "Walk" })).toBeTruthy());
    await waitFor(() => expect(bake.getAttribute("title")).toMatch(/bone map is empty/));
  },
};
