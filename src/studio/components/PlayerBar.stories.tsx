// Stories (ADR 0219, 0349) for the Studio's player bar, "Layout A": idle, a screen's transport and scrub filled in,
// and the right-hand slot reserved for a take's replay.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, within } from "storybook/test";
import { PlayerBar } from "./PlayerBar";

const meta: Meta<typeof PlayerBar> = { title: "Studio/PlayerBar", component: PlayerBar };
export default meta;
type Story = StoryObj<typeof PlayerBar>;

export const Idle: Story = {
  args: { idleArt: "WAV" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Nothing playing")).toBeVisible();
  },
};

export const Auditioning: Story = {
  args: {
    nowPlaying: { art: "PL", title: "Engine loop", subtitle: "Switch · vehicles/engine.playlist.json" },
    transport: (
      <>
        <button aria-label="Previous voice">⏮</button>
        <button class="primary">Trigger</button>
        <button aria-label="Stop">■</button>
      </>
    ),
    scrub: (
      <>
        <span>0:01.2</span>
        <input type="range" aria-label="Position" style={{ flex: 1 }} />
        <span>0:04.0</span>
      </>
    ),
    status: "Auditioning · 3 voices",
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("toolbar", { name: "Transport" })).toBeVisible();
    await expect(c.getByText("Auditioning · 3 voices")).toBeVisible();
  },
};

export const ReplaySlot: Story = {
  args: { nowPlaying: { art: "TAKE", title: "Playtest 3", subtitle: "takes/playtest-3.mycotake" }, replay: <button>Replay take</button> },
};
