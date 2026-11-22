// Stories (ADR 0219, 0335) for the playhead: playing and parked, over a lane.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect } from "storybook/test";
import { Playhead } from "./Playhead";

const meta: Meta<typeof Playhead> = {
  title: "Studio/Playhead",
  component: Playhead,
  decorators: [(Story) => <div style={{ position: "relative", width: "480px", height: "60px", background: "var(--bg-sunken)" }}>{Story()}</div>],
};
export default meta;
type Story = StoryObj<typeof Playhead>;

export const Playing: Story = {
  args: { t: 1, view: { start: 0, end: 4 }, playing: true },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".tl-playhead.playing")).not.toBeNull();
  },
};
export const Parked: Story = { args: { t: 3, view: { start: 0, end: 4 } } };
export const OutOfView: Story = { args: { t: 5, view: { start: 0, end: 4 } } };
