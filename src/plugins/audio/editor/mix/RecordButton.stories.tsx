// Stories (ADR 0219) for the Play toolbar's record toggles (ADR 0348): idle outside Play (disabled), idle while playing,
// recording, saved and failed, each through a real `RecordToggle` over stub seams. The play presses the toggle and
// checks it records, then saves into `recordings/`.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { RecordButton } from "./RecordButton";
import { RecordToggle, type RecordKind } from "./recordToggleModel";

function model(kind: RecordKind, opts: { fail?: boolean } = {}): RecordToggle {
  let state: "idle" | "recording" | "stopped" = "idle";
  return new RecordToggle(kind, {
    recorder: {
      get state() { return state; },
      seconds: 3.5,
      start: async () => {
        if (opts.fail) throw new Error("the audio core hasn't started");
        state = "recording";
      },
      stop: () => void (state = "stopped"),
    },
    bytes: async () => new Uint8Array(8),
    files: () => ["recordings/take_01.sporesample"],
    write: async (path) => path,
  });
}

const meta = {
  title: "Audio/Record toggles",
  component: RecordButton,
  args: { model: model("take"), playing: true, label: "Record take" },
} satisfies Meta<typeof RecordButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OutsidePlay: Story = {
  args: { model: model("take"), playing: false, label: "Record take" },
  play: async ({ canvasElement }) => {
    const b = within(canvasElement).getByRole("button", { name: /Record take/ });
    await expect(b).toBeDisabled();
  },
};

/** Each story with a play has its own toggle (rendered directly, not through args). */
const recordAndSave = model("take");
export const RecordAndSave: Story = {
  args: { model: model("take"), playing: true, label: "Record take" },
  render: () => <RecordButton model={recordAndSave} playing label="Record take" />,
  play: async ({ canvasElement }) => {
    const b = within(canvasElement).getByRole("button", { name: /Record take/ });
    await userEvent.click(b);
    await waitFor(() => expect(b).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(b);
    await waitFor(() => expect(b.title).toMatch(/Saved takes\/take_02\.sporesample/));
  },
};

export const Capture: Story = {
  args: { model: model("capture"), playing: true, label: "Record capture" },
};

const startFails = model("take", { fail: true });
export const StartFails: Story = {
  args: { model: model("take", { fail: true }), playing: true, label: "Record take" },
  render: () => <RecordButton model={startFails} playing label="Record take" />,
  play: async ({ canvasElement }) => {
    const b = within(canvasElement).getByRole("button", { name: /Record take/ });
    await userEvent.click(b);
    await waitFor(() => expect(b.title).toMatch(/Couldn't start the take/));
  },
};
