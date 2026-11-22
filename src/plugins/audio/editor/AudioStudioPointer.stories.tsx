// Stories (ADR 0219) for Project Settings > Audio since the audio panels moved to the Audio Studio (ADR 0327): what the
// category says and its Open in Audio Studio button.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, within } from "storybook/test";
import type { EditorProject } from "../../../editor/projects";
import { AudioStudioPointer } from "./AudioStudioPointer";

const meta = {
  title: "Audio/Project settings pointer",
  component: AudioStudioPointer,
  args: { draft: {}, problems: [], fieldProblems: [], refresh: fn(), set: fn(), project: { root: null, name: "Demo" } as unknown as EditorProject },
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
