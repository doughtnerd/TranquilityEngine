// Stories (ADR 0219, 0335) for the level meter: quiet, hot, clipping (the light stays until clicked), with a scale,
// horizontal, and tainted by a monitor (solo or Compare).
import type { Decorator, Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, within } from "storybook/test";
import { Meter } from "./Meter";

const meta: Meta<typeof Meter> = { title: "Studio/Meter", component: Meter, args: { label: "Master meter", now: 0 } };
export default meta;
type Story = StoryObj<typeof Meter>;

const tall: Decorator = (Story) => (
  <div style={{ height: "160px", display: "flex", gap: "40px" }}>
    <Story />
  </div>
);

export const Quiet: Story = { args: { peakDb: -24, rmsDb: -32, scale: true }, decorators: [tall] };

export const Hot: Story = { args: { peakDb: -3, rmsDb: -9, scale: true }, decorators: [tall] };

export const Clipping: Story = {
  args: { peakDb: 0.4, rmsDb: -4 },
  decorators: [tall],
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const light = c.getByRole("button", { name: "Clipped: click to clear" });
    await expect(light).toBeVisible();
    await userEvent.click(light);
  },
};

export const Silent: Story = { args: { peakDb: null, rmsDb: null }, decorators: [tall] };

export const Horizontal: Story = {
  args: { peakDb: -12, rmsDb: -18, orientation: "horizontal", scale: true },
  decorators: [
    (Story) => (
      <div style={{ width: "260px", paddingBottom: "16px" }}>
        <Story />
      </div>
    ),
  ],
};

export const Tainted: Story = { args: { peakDb: -10, rmsDb: -16, tainted: true }, decorators: [tall] };
