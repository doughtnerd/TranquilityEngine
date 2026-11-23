// Stories (ADR 0219) for the subtitles plugin's Play toolbar toggle (ADR 0343 §6): off, then on (pressed) and off again.
// Outside Play there is no World to overlay, so only the preference changes.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, within } from "storybook/test";
import { OverlayToggle, subtitlesOverlay } from "./OverlayToggle";

const meta: Meta = { title: "Plugins/Subtitles/Play toolbar toggle" };
export default meta;

export const Toggle: StoryObj = {
  render: () => {
    subtitlesOverlay.value = false;
    return <div class="group play-controls"><OverlayToggle /></div>;
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const button = c.getByRole("button", { name: "Subtitles" });
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(button);
    await expect(c.getByRole("button", { name: "Subtitles" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(c.getByRole("button", { name: "Subtitles" }));
    await expect(c.getByRole("button", { name: "Subtitles" })).toHaveAttribute("aria-pressed", "false");
  },
};
