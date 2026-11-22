// Stories (ADR 0219) for Project Settings > Audio since the audio panels moved to the Audio Studio (ADR 0327): what the
// category says and its Open in Audio Studio button.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, within } from "storybook/test";
import { AudioStudioPointer } from "./AudioStudioPointer";

const meta = {
  title: "Audio/Project settings pointer",
  component: AudioStudioPointer,
} satisfies Meta<typeof AudioStudioPointer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Pointer: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/edited in the Audio Studio/)).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Open in Audio Studio" })).toBeEnabled();
  },
};
