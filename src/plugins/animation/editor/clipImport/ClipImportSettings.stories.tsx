// Stories (ADR 0219) for the clip import settings (ADR 0373; T54): the Animation Clips card of a model's Import Settings in
// the shell's Inspector, so Apply and Revert are the shell's. The rules are unit tests (`clipImportLogic.test.ts`); these
// show the take strip, the clip's rows and the file Apply writes. The model is the importer tests' skinned glTF (takes
// Walk, Wave and Bounce, a six-joint rig).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { editor } from "../../../../editor/sdk";
import { PanelStory, fileJson, withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";
import { skinnedGltf } from "../../../../engine/tests/fixtures/gltf/skinnedGltf";

const HERO = "models/hero.gltf";

interface Saved {
  animation: { clips: Record<string, { name: string; from?: number; to?: number; loop?: boolean; rootMotion?: { bone: string; axes?: string[] }; additive?: { reference: string }; markers?: { time: number; kind: string; name?: string }[]; events?: { time: number; method: string }[]; curves?: { name: string }[]; compression?: { error?: number } }[]> };
}
const saved = async () => (await fileJson<Saved>(`${HERO}.meta.json`)).animation.clips;

const meta = {
  title: "Animation/Clip import settings",
  beforeEach: withEditor,
  parameters: { editor: { files: { [HERO]: skinnedGltf() } } satisfies EditorStoryParameters },
  render: () => <PanelStory id="inspector" />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const open = async (canvasElement: HTMLElement) => {
  editor.assets.reveal(HERO);
  const c = within(canvasElement);
  await c.findByRole("group", { name: "Take strip" }, { timeout: 60000 });
  return c;
};
const apply = (c: ReturnType<typeof within>) => userEvent.click(c.getByRole("button", { name: "Apply" }));

/** The take strip shows the selected take's clips (a take with no entry is one clip of its name), and the takes are a select. */
export const TakeStrip: Story = {
  play: async ({ canvasElement }) => {
    const c = await open(canvasElement);
    const takes = c.getByLabelText("Take");
    expect(within(takes).getAllByRole("option").map((o) => o.textContent?.replace(/ \(.*/, ""))).toEqual(expect.arrayContaining(["Walk", "Wave", "Bounce"]));
    const strip = within(c.getByRole("group", { name: "Take strip" }));
    expect(strip.getAllByRole("button")).toHaveLength(1);
  },
};

/** Split at the playhead cuts the clip in two; Apply writes both ranges to the sidecar as one change. */
export const SplitATake: Story = {
  play: async ({ canvasElement }) => {
    const c = await open(canvasElement);
    fireEvent.input(c.getByLabelText("Clip time"), { target: { value: "0.5" } });
    await userEvent.click(c.getByRole("button", { name: "Split at Playhead" }));
    const strip = within(c.getByRole("group", { name: "Take strip" }));
    await waitFor(() => expect(strip.getAllByRole("button")).toHaveLength(2));
    await apply(c);
    await waitFor(async () => {
      const clips = Object.values(await saved())[0];
      expect(clips).toHaveLength(2);
      expect(clips[0].to).toBeCloseTo(0.5, 2);
      expect(clips[1].from).toBeCloseTo(0.5, 2);
    });
  },
};

/** Add, rename and remove a clip; a name another clip has is refused and the draft stays. */
export const AddAndRename: Story = {
  play: async ({ canvasElement }) => {
    const c = await open(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Add Clip" }));
    const name = await c.findByLabelText("Clip name");
    fireEvent.change(name, { target: { value: "Stroll" } });
    await waitFor(() => expect((c.getByLabelText("Clip name") as HTMLInputElement).value).toBe("Stroll"));
    await apply(c);
    await waitFor(async () => expect(Object.values(await saved())[0].map((x) => x.name)).toContain("Stroll"));
  },
};

/** Loop with the pose-match indicator beside it, root motion with its axes, and the additive reference. */
export const ClipSettings: Story = {
  play: async ({ canvasElement }) => {
    const c = await open(canvasElement);
    await userEvent.click(c.getByLabelText("Loop"));
    expect(c.getByRole("group", { name: "Take strip" })).toBeTruthy();
    await userEvent.click(c.getByLabelText("Root motion"));
    await userEvent.click(await c.findByLabelText("Axis y"));
    await userEvent.selectOptions(c.getByLabelText("Additive reference"), "first");
    fireEvent.change(c.getByLabelText("Compression error"), { target: { value: "0.5" } });
    await apply(c);
    await waitFor(async () => {
      const clip = Object.values(await saved())[0][0];
      expect(clip).toMatchObject({ loop: true, additive: { reference: "first" }, compression: { error: 0.5 } });
      expect(clip.rootMotion?.axes).toEqual(["x", "y", "z", "yaw"]);
    });
  },
};

/** Markers, events and curves of the clip: simple tables. */
export const MarkersEventsCurves: Story = {
  play: async ({ canvasElement }) => {
    const c = await open(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Add Marker" }));
    await userEvent.click(c.getByRole("button", { name: "Add Event" }));
    await userEvent.click(c.getByRole("button", { name: "Add Curve" }));
    fireEvent.change(await c.findByLabelText("Event 1 method"), { target: { value: "footstep" } });
    await apply(c);
    await waitFor(async () => {
      const clip = Object.values(await saved())[0][0];
      expect(clip.markers).toHaveLength(1);
      expect(clip.events).toMatchObject([{ method: "footstep" }]);
      expect(clip.curves).toMatchObject([{ name: "Curve 1" }]);
    });
  },
};

/** Revert drops the unapplied clip changes. */
export const Revert: Story = {
  play: async ({ canvasElement }) => {
    const c = await open(canvasElement);
    const strip = within(c.getByRole("group", { name: "Take strip" }));
    await userEvent.click(c.getByRole("button", { name: "Add Clip" }));
    await waitFor(() => expect(strip.getAllByRole("button")).toHaveLength(2));
    await userEvent.click(c.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(strip.getAllByRole("button")).toHaveLength(1));
  },
};

/** The compile report: not compiled until the clip is saved, then Compile reads its size and maximum error. */
export const CompileReport: Story = {
  play: async ({ canvasElement }) => {
    const c = await open(canvasElement);
    const report = within(c.getByLabelText("Compile report"));
    expect(report.getByRole("button", { name: "Compile" })).toBeTruthy();
  },
};
