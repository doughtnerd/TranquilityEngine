// Stories (ADR 0219, 0349) for the player bar's replay slot: a take paused and playing, and inside the player bar.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, within } from "storybook/test";
import { PlayerBar } from "./PlayerBar";
import { ReplayControls, type ReplayControlsProps } from "./ReplayControls";

const meta: Meta<typeof ReplayControls> = {
  title: "Studio/ReplayControls",
  component: ReplayControls,
  args: { title: "canyon_run_03", time: 12.4, duration: 41, playing: false, onToggle: fn(), onSeek: fn(), onShow: fn(), onClose: fn() },
};
export default meta;
type Story = StoryObj<typeof ReplayControls>;

export const Paused: Story = {
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.getByText("00:12.400")).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Replay the take" }));
    await expect(args.onToggle).toHaveBeenCalled();
  },
};

export const Playing: Story = { args: { playing: true, time: 65.25 } };

function Live(props: ReplayControlsProps) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(props.time);
  return <ReplayControls {...props} playing={playing} time={time} onToggle={() => setPlaying(!playing)} onSeek={setTime} />;
}

/** In the player bar's right-hand slot, beside another screen's slots. */
export const InPlayerBar: Story = {
  render: (args) => <PlayerBar nowPlaying={{ art: "MIX", title: "Mixer", subtitle: "audio.json" }} status="Editing Music" replay={<Live {...args} />} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Replay the take" }));
    await expect(c.getByRole("button", { name: "Pause the take" })).toBeVisible();
  },
};
