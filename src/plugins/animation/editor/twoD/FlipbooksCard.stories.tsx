// Stories (ADR 0219) for the Flipbooks card of an image's Import Settings and the Assets panel's Create Flipbook action
// (ADR 0373 "2D tools"; T56): the card edits the Inspector's draft, so Apply and Revert are the shell's; the action writes
// the sidecar at once. The rules are unit tests (`flipbookLogic.test.ts`, `register.test.ts`); these show the views and the
// file Apply writes.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { editor } from "../../../../editor/sdk";
import { PanelStory, fileJson, withEditor, type EditorStoryParameters } from "../../../../editor/stories/editorStory";
import { SHEET_SIDECAR, sheetBytes } from "./twoDStoryFixtures";

const IMAGE = "sheets/hero.png";
const files = { [IMAGE]: sheetBytes(), [`${IMAGE}.meta.json`]: SHEET_SIDECAR };

const meta = {
  title: "Animation/2D tools/Flipbooks card",
  beforeEach: withEditor,
  parameters: { editor: { files } satisfies EditorStoryParameters },
  render: () => <PanelStory id="inspector" />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const open = async (canvasElement: HTMLElement) => {
  editor.assets.reveal(IMAGE);
  const c = within(canvasElement);
  await c.findByLabelText("Use slice walk_0", {}, { timeout: 30000 });
  return c;
};

/** Checking slices and creating a flipbook edits the draft; Apply writes `flipbooks` to the sidecar, frames in name order. */
export const CreateAndApply: Story = {
  play: async ({ canvasElement }) => {
    const c = await open(canvasElement);
    for (const n of ["walk_2", "walk_0", "walk_1"]) await userEvent.click(c.getByLabelText(`Use slice ${n}`));
    await userEvent.click(c.getByRole("button", { name: /Create Flipbook/ }));
    await waitFor(() => expect(c.getByRole("list", { name: "Frames" })).toBeTruthy());
    await userEvent.click(c.getByRole("button", { name: "Apply" }));
    await waitFor(async () => expect((await fileJson<{ flipbooks: Record<string, unknown> }>(`${IMAGE}.meta.json`)).flipbooks).toEqual({ walk: { slices: ["walk_0", "walk_1", "walk_2"] } }));
  },
};

/** Revert drops a flipbook the card made before Apply; the shell's own button. */
export const Revert: Story = {
  play: async ({ canvasElement }) => {
    const c = await open(canvasElement);
    await userEvent.click(c.getByLabelText("Use slice walk_3"));
    await userEvent.click(c.getByRole("button", { name: /Create Flipbook/ }));
    await waitFor(() => expect(c.getByRole("list", { name: "Frames" })).toBeTruthy());
    await userEvent.click(c.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(c.queryByRole("list", { name: "Frames" })).toBeNull());
  },
};
