// Stories (ADR 0219, 0349) for the Studio's status bar: running on the core with its figures, waiting for a click,
// trouble (underruns, a full voice cap, effect memory full), and the core unavailable with why.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, within } from "storybook/test";
import { CORE_UNAVAILABLE } from "../runtime/studioAudioHost";
import { StudioStatusBar } from "./StudioStatusBar";

const stats = { backend: "core", status: "running", sampleRate: 48000, voices: 3, voiceCap: 4096, cpuPercent: 4.2, cpuNote: null, underruns: 0, latencyMs: 23, latencyReliable: true, bufferMs: 5.3, fxStarved: 0, fxStarvedOwner: null };

const meta: Meta<typeof StudioStatusBar> = { title: "Studio/StudioStatusBar", component: StudioStatusBar };
export default meta;
type Story = StoryObj<typeof StudioStatusBar>;

export const Running: Story = {
  args: { state: { kind: "running" }, stats, message: { kind: "info", text: "Opened Racer" }, clock: { label: "Playhead", seconds: 0.52 }, document: "saved" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("Rust core · 48 kHz")).toBeVisible();
    await expect(c.getByText("Voices 3 / 4,096")).toBeVisible();
    await expect(c.getByText("Playhead 00:00.520")).toBeVisible();
    await expect(c.getByText("Device OK")).toBeVisible();
    await expect(c.getByText("Saved")).toBeVisible();
  },
};

export const Locked: Story = { args: { state: { kind: "locked" }, stats: null } };

export const Trouble: Story = { args: { state: { kind: "running" }, stats: { ...stats, voices: 64, voiceCap: 64, underruns: 3, cpuPercent: 91 }, clock: { label: "Session", seconds: 12.3 }, document: "unsaved" } };

/** ADR 0345 (ABI 4.8): effects got no effect memory: a warning naming the last owner in its tooltip. */
export const EffectMemoryFull: Story = {
  args: { state: { kind: "running" }, stats: { ...stats, fxStarved: 2, fxStarvedOwner: "Ambience" } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Effect memory full")).toHaveAttribute("title", expect.stringContaining("(last: Ambience)"));
  },
};

export const CoreUnavailable: Story = {
  args: { state: { kind: "failed", reason: CORE_UNAVAILABLE }, stats: null },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Audio core unavailable")).toHaveAttribute("title", CORE_UNAVAILABLE);
  },
};
