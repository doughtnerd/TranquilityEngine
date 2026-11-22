// Stories (ADR 0219, 0335) for the gain lanes panel: a bus inside a VCA under two parents, a ducked bus in a snapshot
// with automation, a bus silenced by another's solo, a muted parent, and nothing selected.
import type { Decorator, Meta, StoryObj } from "@storybook/preact-vite";
import { expect, within } from "storybook/test";
import { GainLanes } from "./GainLanes";
import type { GainInputs } from "./gainLanesModel";

const mix: GainInputs = {
  buses: [
    { name: "Master", parent: null, volumeDb: 0, mute: false },
    { name: "SFX", parent: "Master", volumeDb: -2, mute: false },
    { name: "Vehicles", parent: "SFX", volumeDb: -4, mute: false },
    { name: "Engine", parent: "Vehicles", volumeDb: -3, mute: false },
    { name: "Ambience", parent: "Master", volumeDb: -10, mute: false },
    { name: "Dialogue", parent: "Master", volumeDb: 0, mute: false },
    { name: "Music", parent: "Master", volumeDb: -10, mute: false },
  ],
  returns: [{ name: "Reverb", output: "Master", volumeDb: -3, mute: false }],
  vcas: [{ name: "Gameplay SFX", volumeDb: -2, members: ["Vehicles"] }],
};

const meta: Meta<typeof GainLanes> = { title: "Studio/GainLanes", component: GainLanes };
export default meta;
type Story = StoryObj<typeof GainLanes>;

const panel: Decorator = (Story) => (
  <div style={{ width: "300px" }}>
    <Story />
  </div>
);

export const InsideVca: Story = {
  args: { inputs: mix, bus: "Engine" },
  decorators: [panel],
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("row", { name: /You hear/ })).toHaveTextContent("−11.0 dB");
  },
};

export const DuckedInSnapshot: Story = {
  args: { inputs: { ...mix, snapshot: { name: "Underwater", buses: { Music: -6 } }, live: { Music: { duck: -6, automation: -1.5 } } }, bus: "Music" },
  decorators: [panel],
};

export const SilencedBySolo: Story = { args: { inputs: { ...mix, solo: "Dialogue" }, bus: "Ambience" }, decorators: [panel] };

export const MutedParent: Story = { args: { inputs: { ...mix, buses: mix.buses.map((b) => (b.name === "SFX" ? { ...b, mute: true } : b)) }, bus: "Vehicles" }, decorators: [panel] };

export const NothingSelected: Story = { args: { inputs: mix, bus: null }, decorators: [panel] };
