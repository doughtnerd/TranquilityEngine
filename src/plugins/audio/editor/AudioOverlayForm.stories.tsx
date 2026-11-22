// Stories (ADR 0219) for the Scene toolbar's Audio popover: the occlusion rays toggle, remembered per user
// (`occlusionOverlayOn`). The play turns it on and off.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, within } from "storybook/test";
import { AudioOverlayForm } from "./AudioOverlayForm";
import { occlusionOverlayOn } from "./OcclusionOverlay";

const meta = {
  title: "Audio/Scene overlay",
  component: AudioOverlayForm,
  beforeEach: () => {
    const was = occlusionOverlayOn.value;
    occlusionOverlayOn.value = false;
    return () => void (occlusionOverlayOn.value = was);
  },
} satisfies Meta<typeof AudioOverlayForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OcclusionRays: Story = {
  play: async ({ canvasElement }) => {
    const box = within(canvasElement).getByRole("checkbox", { name: "Occlusion rays" });
    await expect(box).not.toBeChecked();
    await userEvent.click(box);
    await expect(occlusionOverlayOn.value).toBe(true);
    await userEvent.click(box);
    await expect(occlusionOverlayOn.value).toBe(false);
  },
};
