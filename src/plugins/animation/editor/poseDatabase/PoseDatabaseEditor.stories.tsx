// Stories (ADR 0219) for the pose database tool (ADR 0373; T55): a `*.posedb.json` selected in the Assets panel. Each edit goes
// through the source's asset document, so each story checks the file it writes and its Undo and Redo. The rules (validation by
// the source parse) are unit tests (`poseDbLogic.test.ts`); the bake is `BakeCard.stories.tsx`.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { fileJson, withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";
import { PoseDatabaseEditor } from "./PoseDatabaseEditor";

const DB = "animation/loco.posedb.json";

interface Saved {
  skeleton?: string;
  rate?: number;
  normalisation?: string;
  sources?: { clip: string; ranges?: { from: number; to: number; tags?: string[] }[]; mirror?: boolean }[];
  schema?: { bones?: { bone: string; position?: boolean; velocity?: boolean; weight?: number }[]; trajectory?: { times?: number[]; position?: number; direction?: number }; custom?: { name: string; dims?: number }[] };
}

const walk = { format: "myco.anim-source@1", duration: 4, loop: true };
const loco = {
  format: "myco.posedb-source@1",
  sources: [{ clip: "asset:clips/walk.anim.json", ranges: [{ from: 0, to: 2, tags: ["walk"] }, { from: 2, to: 4, tags: ["stop"] }] }],
};

const saved = () => fileJson<Saved>(DB);

const meta = {
  title: "Animation/Pose database",
  component: PoseDatabaseEditor,
  beforeEach: withEditor,
  parameters: { editor: { files: { [DB]: loco, "clips/walk.anim.json": walk, "clips/run.anim.json": { ...walk, duration: 2 } } } satisfies EditorStoryParameters },
  args: { path: DB },
} satisfies Meta<typeof PoseDatabaseEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A clip with its length and its ranges, and the tags with their seconds. */
export const ClipsAndTags: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByText("4.00 s")).toBeTruthy());
    expect(c.getByRole("button", { name: /Range 1: 0.00–2.00 s walk/ })).toBeTruthy();
    expect(c.getByRole("button", { name: /Range 2: 2.00–4.00 s stop/ })).toBeTruthy();
    const tags = within(c.getByLabelText("Tags"));
    expect(tags.getByText(/walk 2.0 s/)).toBeTruthy();
    expect(tags.getByText(/stop 2.0 s/)).toBeTruthy();
  },
};

/** A clip picked from the project is added with no ranges, and undone and redone. */
export const AddAndRemoveClips: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByLabelText("Add clip"), "asset:clips/run.anim.json");
    await waitFor(async () => expect((await saved()).sources?.map((s) => s.clip)).toEqual(["asset:clips/walk.anim.json", "asset:clips/run.anim.json"]));
    await userEvent.click(c.getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await saved()).sources).toHaveLength(1));
    await userEvent.click(c.getByRole("button", { name: "Redo" }));
    await waitFor(async () => expect((await saved()).sources).toHaveLength(2));
    await userEvent.click(c.getByRole("button", { name: "Remove run.anim.json" }));
    await waitFor(async () => expect((await saved()).sources).toHaveLength(1));
  },
};

/** Add Range takes the whole clip; its times and tags are typed, a bad tag is refused and the file keeps its tags. */
export const RangesAndTags: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByText("4.00 s")).toBeTruthy());
    await userEvent.click(c.getByRole("button", { name: "Add Range" }));
    await waitFor(async () => expect((await saved()).sources?.[0]?.ranges).toHaveLength(3));
    expect((await saved()).sources?.[0]?.ranges?.[2]).toMatchObject({ from: 0, to: 4 });
    fireEvent.change(c.getByLabelText("To of range 3 of walk.anim.json"), { target: { value: "1.5" } });
    await waitFor(async () => expect((await saved()).sources?.[0]?.ranges?.[2]?.to).toBe(1.5));
    const tags = c.getByLabelText("Tags of range 3 of walk.anim.json");
    fireEvent.change(tags, { target: { value: "turn, loop turn" } });
    await waitFor(async () => expect((await saved()).sources?.[0]?.ranges?.[2]?.tags).toEqual(["turn", "loop"]));
    fireEvent.change(tags, { target: { value: "no good" } });
    fireEvent.change(tags, { target: { value: "bad$tag" } });
    await new Promise((r) => setTimeout(r, 150));
    expect((await saved()).sources?.[0]?.ranges?.[2]?.tags).toEqual(["turn", "loop"]);
    await userEvent.click(c.getByRole("button", { name: "Remove range 3 of walk.anim.json" }));
    await waitFor(async () => expect((await saved()).sources?.[0]?.ranges).toHaveLength(2));
  },
};

/** A range that ends before it starts is refused, and the file is unchanged. */
export const RefusedRange: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    fireEvent.change(c.getByLabelText("To of range 1 of walk.anim.json"), { target: { value: "-1" } });
    await new Promise((r) => setTimeout(r, 150));
    expect((await saved()).sources?.[0]?.ranges?.[0]).toMatchObject({ from: 0, to: 2 });
  },
};

/** The mirror switch of a clip. */
export const Mirror: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByLabelText("Mirror walk.anim.json"));
    await waitFor(async () => expect((await saved()).sources?.[0]?.mirror).toBe(true));
  },
};

/** The rate and the normalisation. */
export const DatabaseSettings: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    fireEvent.change(c.getByLabelText("Rate"), { target: { value: "60" } });
    await waitFor(async () => expect((await saved()).rate).toBe(60));
    for (const mode of ["dimension", "none"]) {
      await userEvent.selectOptions(c.getByLabelText("Normalisation"), mode);
      await waitFor(async () => expect((await saved()).normalisation).toBe(mode));
    }
  },
};

/** Bone features: one is added, its velocity switched off and its weight set; every one has a remove button. */
export const BoneFeatures: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText("30 dimensions per frame.", { exact: false })).toBeTruthy();
    await userEvent.type(c.getByLabelText("New bone feature"), "LeftHand");
    await userEvent.click(c.getByRole("button", { name: "Add Bone" }));
    await waitFor(async () => expect((await saved()).schema?.bones?.map((b) => b.bone)).toEqual(["LeftFoot", "RightFoot", "Hips", "LeftHand"]));
    await userEvent.click(c.getByLabelText("Velocity of LeftHand"));
    await waitFor(async () => expect((await saved()).schema?.bones?.[3]).toMatchObject({ bone: "LeftHand", velocity: false }));
    fireEvent.change(c.getByLabelText("Weight of LeftHand"), { target: { value: "2.5" } });
    await waitFor(async () => expect((await saved()).schema?.bones?.[3]?.weight).toBe(2.5));
    await userEvent.click(c.getByRole("button", { name: "Remove Hips" }));
    await waitFor(async () => expect((await saved()).schema?.bones?.map((b) => b.bone)).toEqual(["LeftFoot", "RightFoot", "LeftHand"]));
  },
};

/** The trajectory's sample times and weights. */
export const Trajectory: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const times = c.getByLabelText("Trajectory sample times");
    fireEvent.change(times, { target: { value: "-0.25, 0.5, 1" } });
    await waitFor(async () => expect((await saved()).schema?.trajectory?.times).toEqual([-0.25, 0.5, 1]));
    fireEvent.change(c.getByLabelText("Trajectory position weight"), { target: { value: "3" } });
    await waitFor(async () => expect((await saved()).schema?.trajectory?.position).toBe(3));
    fireEvent.change(c.getByLabelText("Trajectory direction weight"), { target: { value: "0.5" } });
    await waitFor(async () => expect((await saved()).schema?.trajectory?.direction).toBe(0.5));
  },
};

/** Custom features. */
export const CustomFeatures: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.type(c.getByLabelText("New custom feature"), "speed");
    await userEvent.click(c.getByRole("button", { name: "Add Custom" }));
    await waitFor(async () => expect((await saved()).schema?.custom?.[0]?.name).toBe("speed"));
    fireEvent.change(await c.findByLabelText("Dimensions of speed"), { target: { value: "3" } });
    await waitFor(async () => expect((await saved()).schema?.custom?.[0]?.dims).toBe(3));
    await userEvent.click(c.getByRole("button", { name: "Remove speed" }));
    await waitFor(async () => expect((await saved()).schema?.custom).toBeUndefined());
  },
};
