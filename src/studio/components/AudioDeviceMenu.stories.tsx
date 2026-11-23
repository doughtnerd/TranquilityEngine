// Stories (ADR 0219, 0349) for the output-device menu: not calibrated, calibrated with offsets, the output changed
// since; typing an offset clamps it to ±300 ms; Calibrate… opens the tap dialog (silent clicks here).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { AudioDeviceMenu } from "./AudioDeviceMenu";
import type { ClickTrack } from "./clickTrack";
import type { DeviceOffsets } from "./deviceOffsets";

const silent: ClickTrack = { start() {}, stop() {} };

function Demo(props: { calibrated?: boolean; stale?: boolean }) {
  const [offsets, setOffsets] = useState<DeviceOffsets>(props.calibrated ? { audio: 23, visual: -8 } : { audio: 0, visual: 0 });
  const [calibrated, setCalibrated] = useState(!!props.calibrated);
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <AudioDeviceMenu
        deviceName="System output · Speakers (Realtek)"
        offsets={offsets}
        calibrated={calibrated}
        stale={props.stale}
        latencyMs={31}
        clicks={silent}
        onOffset={(kind, ms) => {
          setOffsets({ ...offsets, [kind]: ms });
          setCalibrated(true);
        }}
      />
    </div>
  );
}

const meta: Meta = { title: "Studio/AudioDeviceMenu", component: AudioDeviceMenu };
export default meta;

export const NotCalibrated: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: /Not calibrated/ }));
    const field = c.getByLabelText("Audio offset");
    await userEvent.clear(field);
    await userEvent.type(field, "450");
    await userEvent.tab();
    await expect(field).toHaveValue(300);
  },
};

export const Calibrated: StoryObj = { render: () => <Demo calibrated /> };

export const OutputChanged: StoryObj = { render: () => <Demo calibrated stale /> };

export const OpensCalibration: StoryObj = {
  render: () => <Demo calibrated />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: /\+23 ms/ }));
    await userEvent.click(c.getAllByRole("button", { name: "Calibrate…" })[0]);
    await expect(c.getByRole("dialog", { name: "Calibrate: Audio offset" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect(c.queryByRole("dialog", { name: "Calibrate: Audio offset" })).toBeNull();
  },
};
