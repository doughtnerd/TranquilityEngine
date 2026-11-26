// Stories (ADR 0348, 0373; T73) for the take controls of the animation debugger: the picker closed, opening, open and
// refused, the notes of a project that changed since the take, and the recorder bar over a take (no Keep control).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, within } from "storybook/test";
import type { AnimatorDebugFrame } from "../../runtime/features/debug/frame";
import { RecorderBar } from "./RecorderBar";
import { TakeNotes, TakePicker } from "./TakeBar";
import "./debugger.css";

const FILES = ["recordings/run_01.sporesample", "recordings/boss_fight.sporesample"];

const meta = {
  title: "Animation/Debugger/Take",
  render: (args) => <div style={{ width: "560px" }}><TakePicker {...args} /></div>,
  args: { files: FILES, open: null, busy: false, error: null, onOpen: fn(), onClose: fn() },
} satisfies Meta<typeof TakePicker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.selectOptions(c.getByLabelText("Take file"), "recordings/boss_fight.sporesample");
    await userEvent.click(c.getByRole("button", { name: "Open take" }));
    await expect(args.onOpen).toHaveBeenCalledWith("recordings/boss_fight.sporesample");
  },
};

export const NoTakes: Story = {
  args: { files: [] },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByLabelText("Take file")).toBeDisabled();
    await expect(c.getByRole("button", { name: "Open take" })).toBeDisabled();
  },
};

export const Opening: Story = {
  args: { busy: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Opening…" })).toBeDisabled();
  },
};

export const Open: Story = {
  args: { open: FILES[0] },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.getByText("Take run_01")).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Close take" }));
    await expect(args.onClose).toHaveBeenCalled();
  },
};

export const Refused: Story = {
  args: { error: "This take has no animation in it: no graph Animator ran while it recorded." },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent("no graph Animator ran");
  },
};

export const Notes: StoryObj<typeof TakeNotes> = {
  render: () => (
    <div style={{ width: "560px" }}>
      <TakeNotes notes={['The parameter "moving" is gone from the graph.', 'The graph has a new state "Locomotion/Run".', "Poses can't be re-evaluated: the recorded state doesn't fit the graph as it is now."]} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole("listitem")).toHaveLength(3);
  },
};

export const NoNotes: StoryObj<typeof TakeNotes> = {
  render: () => <TakeNotes notes={[]} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("status")).toBeNull();
  },
};

const frames: AnimatorDebugFrame[] = Array.from({ length: 300 }, (_, i) => ({
  index: i,
  time: (i + 1) / 30,
  report: { instance: 1, nodes: [], machines: [], transitions: [], requests: [], dropped: 0 },
  parameters: [],
  inputs: [],
  root: [],
}));

function RecorderOverTake() {
  const [scrub, setScrub] = useState<number | null>(120);
  return (
    <div style={{ width: "640px" }}>
      <RecorderBar frames={frames} isKeyframe={(i) => i % 30 === 0} scrub={scrub} onScrub={setScrub} seconds={10} paused poseShown />
    </div>
  );
}

export const RecorderOverATake: StoryObj<typeof meta> = {
  render: () => <RecorderOverTake />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // A take keeps everything it recorded: there's no length to choose.
    await expect(c.queryByLabelText("Seconds kept")).toBeNull();
    await userEvent.click(c.getByRole("button", { name: "Live" }));
    await expect(c.getByLabelText("Scrubbed time")).toHaveTextContent("live");
  },
};
