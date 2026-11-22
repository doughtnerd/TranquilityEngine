// Stories (ADR 0219, 0335) for the value lane: a game parameter with its value at the cursor, a held (stepped) voice
// count against a voice limit line, a bus's gain on a fixed dB range, and a lane with no data.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, within } from "storybook/test";
import { AXIS, SPEED, VOICE_COUNT, WIDTH } from "./laneStoryData";
import { ValueLane } from "./ValueLane";

const meta: Meta<typeof ValueLane> = { title: "Studio/ValueLane", component: ValueLane, args: { toX: AXIS.toX, width: WIDTH } };
export default meta;
type Story = StoryObj<typeof ValueLane>;

export const GameParameter: Story = {
  args: { label: "Speed", unit: "km/h", decimals: 0, points: SPEED, cursor: 12, series: 1 },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("group", { name: /^Speed: \d+ km\/h$/ })).toBeVisible();
  },
};

export const VoicesAgainstLimit: Story = { args: { label: "Voices", decimals: 0, points: VOICE_COUNT, interp: "step", reference: { value: 4, label: "voice limit 4" }, cursor: 21, series: 3 } };

export const BusGain: Story = {
  args: {
    label: "Bus · Music",
    unit: "dB",
    decimals: 1,
    range: [-30, 0],
    points: [{ t: 0, v: -10 }, { t: 15.8, v: -10 }, { t: 16, v: -16 }, { t: 24, v: -16 }, { t: 24.4, v: -10 }, { t: 32, v: -10 }],
    cursor: 18,
    series: 5,
  },
};

export const NoData: Story = { args: { label: "Loudness", unit: "LUFS", points: [], cursor: 4 } };
