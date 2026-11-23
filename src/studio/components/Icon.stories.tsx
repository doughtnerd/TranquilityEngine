// Stories (ADR 0219, 0361) for the Studio's icon set and transport buttons: every icon with its name, and the player
// bar's transport buttons (primary, pressed, with text, disabled), themed by Settings > Appearance.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ICON_NAMES, Icon } from "./Icon";
import { TransportButton } from "./PlayerBar";

const meta: Meta = { title: "Studio/Icon", component: Icon };
export default meta;

export const All: StoryObj = {
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: "10px", color: "var(--text)" }}>
      {ICON_NAMES.map((name) => (
        <div key={name} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Icon name={name} size={20} />
          <span style={{ color: "var(--muted)" }}>{name}</span>
        </div>
      ))}
      <Icon name="warning" label="Not calibrated" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    // Decorative icons are hidden from assistive tech; one given a label reads as an image.
    await expect(c.getAllByRole("img")).toHaveLength(1);
    await expect(c.getByRole("img", { name: "Not calibrated" })).toBeVisible();
  },
};

export const Transport: StoryObj<{ onPlay: () => void; onLoop: () => void }> = {
  args: { onPlay: fn(), onLoop: fn() },
  render: (args) => (
    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
      <TransportButton icon="skipBack" label="Return to start" onClick={() => {}} />
      <TransportButton icon="play" label="Play" title="Play (Space)" primary onClick={args.onPlay} />
      <TransportButton icon="loop" label="Loop" pressed onClick={args.onLoop} />
      <TransportButton icon="chevronRight" label="Release" text onClick={() => {}} />
      <TransportButton icon="stop" label="Stop" disabled onClick={() => {}} />
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Play" }));
    await expect(args.onPlay).toHaveBeenCalledOnce();
    await expect(c.getByRole("button", { name: "Loop" })).toHaveAttribute("aria-pressed", "true");
    await expect(c.getByRole("button", { name: "Release" })).toHaveTextContent("Release");
    await expect(c.getByRole("button", { name: "Stop" })).toBeDisabled();
  },
};
