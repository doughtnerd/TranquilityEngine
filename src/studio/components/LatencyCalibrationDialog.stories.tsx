// Stories (ADR 0219, 0335) for latency calibration: by ear (silent clicks here) and by eye (the flashing boxes);
// four taps make "Use" available, Start over clears them, Escape cancels.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { ClickTrack } from "./clickTrack";
import { LatencyCalibrationDialog, type CalibrationMode } from "./LatencyCalibrationDialog";

const silent: ClickTrack = { start() {}, stop() {} };

function Demo(props: { mode: CalibrationMode }) {
  const [result, setResult] = useState("open");
  return (
    <div>
      <output aria-label="Result">{result}</output>
      {result === "open" && <LatencyCalibrationDialog what="Audio offset" device="System output" mode={props.mode} clicks={silent} onUse={(ms) => setResult(`use ${ms}`)} onCancel={() => setResult("cancelled")} />}
    </div>
  );
}

const meta: Meta = { title: "Studio/LatencyCalibrationDialog", component: LatencyCalibrationDialog };
export default meta;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const ByEar: StoryObj = {
  render: () => <Demo mode="ear" />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const use = c.getByRole("button", { name: "Use" });
    await expect(use).toBeDisabled();
    await wait(450); // past the first beat
    for (let i = 0; i < 4; i++) {
      await userEvent.click(c.getByRole("button", { name: "Tap" }));
      await wait(120);
    }
    await waitFor(() => expect(c.getByRole("button", { name: /^Use / })).toBeEnabled());
    await userEvent.click(c.getByRole("button", { name: "Start over" }));
    await expect(c.getByText("No taps yet.")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect(c.getByLabelText("Result")).toHaveTextContent("cancelled");
  },
};

export const ByEye: StoryObj = { render: () => <Demo mode="eye" /> };
