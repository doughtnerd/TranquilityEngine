// Stories (ADR 0219) for the pose database tool's Bake card and the baked file's summary (ADR 0373; T55). The card runs the bake
// over an environment given as a prop, so these give it a fake one: what the bake writes and how it reports progress, failure
// and warnings. The real bake through the editor module is `bake.node.test.ts`; the summary's reader is `summaryLogic.test.ts`.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { editor } from "../../../../editor/sdk";
import { withEditor, storyProject, type EditorStoryParameters } from "../../../../editor/stories/editorStory";
import { encodeSkeleton } from "../../../../engine/animation/import/skeletonBinary";
import { parsePoseDatabase, emptyPoseDatabase } from "../../../../engine/animation/poseDatabase";
import { BakeCard, type BakeCardProps } from "./BakeCard";
import { BakedSummary } from "./BakedSummary";
import type { PoseDbBakeEnv } from "./bakeLogic";
import { matchDebugView } from "./poseDbDebug";
import type { PoseDbSummary } from "./summaryLogic";

const DB = "animation/loco.posedb.json";

/** A skeleton file with the default schema's bones, written by the importer's own encoder: the bake's input step reads it, the bake itself is the fake's. */
const small = encodeSkeleton({
  bones: ["Hips", "LeftFoot", "RightFoot"].map((name, i) => ({ name, parent: i === 0 ? -1 : 0, rest: { position: [0, i, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } })),
  inverseBinds: new Float32Array(3 * 12).map((_, i) => ([0, 5, 10].includes(i % 12) ? 1 : 0)),
  roles: [null, null, null],
  profile: null,
});

const source = parsePoseDatabase({ format: "myco.posedb-source@1", skeleton: "asset:rigs/hero.skel", sources: [{ clip: "asset:clips/walk.anim.json" }] }).value;

/** A fake bake environment: records writes, with the outcome the story picks. */
function fakeEnv(options: { fail?: string; written?: Map<string, Uint8Array> } = {}): PoseDbBakeEnv {
  return {
    clipSkeleton: async () => null,
    skeleton: async () => small,
    clip: async () => ({ bytes: new Uint8Array([1]) }),
    run: async () => (options.fail ? { ok: false, error: options.fail } : { ok: true, bytes: new Uint8Array([1, 2, 3]) }),
    writeBytes: async (path, bytes) => void options.written?.set(path, bytes),
  };
}

/** The card over the story's project. */
function BakeStory(props: Omit<BakeCardProps, "project">) {
  return (
    <div class="asset-inspector" style={{ width: "360px" }}>
      <BakeCard {...props} project={storyProject()} />
    </div>
  );
}

const meta = {
  title: "Animation/Pose database/Bake",
  component: BakeStory,
  beforeEach: withEditor,
  parameters: { editor: { files: { [DB]: { format: "myco.posedb-source@1" } } } satisfies EditorStoryParameters },
  args: { path: DB, db: source, env: fakeEnv() },
} satisfies Meta<typeof BakeStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Not baked yet: where the file will go, and a Bake button that works. */
export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText(/Not baked yet: animation\/loco.posedb.bin/)).toBeTruthy();
    expect(c.getByRole("button", { name: "Bake" })).toBeEnabled();
  },
};

/** A database with no clips can't be baked, and says why. */
export const NoClips: Story = {
  args: { db: emptyPoseDatabase() },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByRole("button", { name: "Bake" })).toBeDisabled();
    expect(c.getByText("Add a clip first.")).toBeTruthy();
  },
};

/** A read-only project can't be baked into. */
export const ReadOnly: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByRole("button", { name: "Bake" })).toBeDisabled();
    expect(c.getByText("This project can't be changed.")).toBeTruthy();
  },
};

/** Baking: the stage text and a progress bar while it runs, then the path of the file written. */
export const Baking: Story = {
  args: { env: undefined },
  render: (args) => {
    const written = new Map<string, Uint8Array>();
    const env = fakeEnv({ written });
    // Hold the bake open so the progress shows.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const run: PoseDbBakeEnv["run"] = async (job) => {
      await gate;
      return env.run(job);
    };
    (globalThis as { __posedbRelease?: () => void }).__posedbRelease = release;
    return <BakeStory {...args} env={{ ...env, run }} />;
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Bake" }));
    await waitFor(() => expect(c.getByRole("status", { name: "Bake progress" })).toBeTruthy());
    expect(c.getByRole("button", { name: "Baking…" })).toBeDisabled();
    (globalThis as unknown as { __posedbRelease: () => void }).__posedbRelease();
    await waitFor(() => expect(c.getByText("Wrote animation/loco.posedb.bin.")).toBeTruthy());
  },
};

/** A failed bake: the reason, in an alert. */
export const Failure: Story = {
  args: { env: fakeEnv({ fail: "feature 3 is out of range" }) },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Bake" }));
    await waitFor(() => expect(c.getByRole("alert")).toHaveTextContent("the bake failed: feature 3 is out of range"));
  },
};

/** The debug view's toggle, and its note on what feeds it. */
export const DebugView: Story = {
  beforeEach: () => {
    matchDebugView.value = false;
    return () => void (matchDebugView.value = false);
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    expect(c.getByText(/Nothing feeds the view yet/)).toBeTruthy();
    await userEvent.click(c.getByLabelText("Show the match debug view in the viewport"));
    await waitFor(() => expect(matchDebugView.value).toBe(true));
    await userEvent.click(c.getByLabelText("Show the match debug view in the viewport"));
    await waitFor(() => expect(matchDebugView.value).toBe(false));
    expect(editor.project.current).toBeTruthy();
  },
};

const summary: PoseDbSummary = {
  size: 53_248, frames: 540, dims: 30, rate: 30, seconds: 18, skeleton: "asset:rigs/hero.skel", kdTree: true,
  features: [{ kind: "bone position", count: 3 }, { kind: "bone velocity", count: 3 }, { kind: "trajectory position", count: 3 }, { kind: "trajectory direction", count: 3 }],
  clips: [{ asset: "asset:clips/walk.anim.json", frames: 300 }, { asset: "asset:clips/run.anim.json", frames: 240 }],
  tags: [{ name: "walk", frames: 300 }, { name: "run", frames: 240 }],
};

/** A baked file's summary: frames, size, dimensions, the clips and the tags with their frames. */
export const Summary: StoryObj = {
  render: () => (
    <div class="asset-inspector" style={{ width: "360px" }}>
      <BakedSummary summary={summary} path="animation/loco.posedb.bin" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const s = within(c.getByLabelText("Summary of animation/loco.posedb.bin"));
    expect(s.getByText("540 (18.0 s at 30 Hz)")).toBeTruthy();
    expect(s.getByText("52.0 KB")).toBeTruthy();
    expect(s.getByText("walk: 300 frames")).toBeTruthy();
    expect(s.getByText("run: 240 frames")).toBeTruthy();
    expect(s.getByText("clips/walk.anim.json: 300 frames")).toBeTruthy();
  },
};
