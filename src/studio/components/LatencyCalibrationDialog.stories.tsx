// Stories (ADR 0219, 0349) for latency calibration, as the prototype draws it: by ear (silent clicks here) and by eye,
// four beat lights either way; taps (the big button, Space) plot dots and the large readout gives the offset; four taps
// make "Use" available, Start over clears them, × or Escape cancels.
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
    await expect(c.getByRole("dialog", { name: "Calibrate audio offset" })).toBeVisible();
    await expect(c.getByRole("radio", { name: "By ear" })).toHaveAttribute("aria-checked", "true");
    const use = c.getByRole("button", { name: /^Use/ });
    await expect(use).toBeDisabled();
    await expect(use).toHaveTextContent("Use (4+ taps)");
    await wait(450); // past the first beat
    await userEvent.click(c.getByRole("button", { name: "Tap on the beat" }));
    await wait(120);
    // Space taps too (the prototype's Space didn't).
    for (let i = 0; i < 3; i++) {
      await userEvent.keyboard(" ");
      await wait(120);
    }
    await waitFor(() => expect(c.getByRole("button", { name: /^Use [+−0]/ })).toBeEnabled());
    await expect(c.getByText("4 taps", { exact: false })).toBeVisible();
    await expect(canvasElement.querySelectorAll(".studio-calibrate-dot")).toHaveLength(4);
    await expect(canvasElement.querySelector(".studio-calibrate-readout-value")!.textContent).toMatch(/ms$/);
    await userEvent.click(c.getByRole("button", { name: "Start over" }));
    await expect(canvasElement.querySelector(".studio-calibrate-readout-value")).toHaveTextContent("—");
    await userEvent.keyboard("{Escape}");
    await expect(c.getByLabelText("Result")).toHaveTextContent("cancelled");
  },
};

export const ByEye: StoryObj = {
  render: () => <Demo mode="eye" />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("Tap when each box lights.")).toBeVisible();
    await expect(canvasElement.querySelectorAll(".studio-calibrate-light")).toHaveLength(4);
    await waitFor(() => expect(canvasElement.querySelector(".studio-calibrate-light.lit")).not.toBeNull(), { timeout: 2000 });
    await userEvent.click(c.getByRole("button", { name: "Close" }));
    await expect(c.getByLabelText("Result")).toHaveTextContent("cancelled");
  },
};
