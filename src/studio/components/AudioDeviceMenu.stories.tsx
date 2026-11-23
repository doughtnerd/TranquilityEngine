// Stories (ADR 0219, 0349) for the output-device menu: not calibrated, calibrated with offsets, the output changed
// since; typing an offset clamps it to ±300 ms; Calibrate… opens the tap dialog (silent clicks here).
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { AudioDeviceMenu } from "./AudioDeviceMenu";

/** The menu and dialog float at the page's root (out of the header's container queries): find them there. */
const page = () => within(document.body);
import type { ClickTrack } from "./clickTrack";
import type { DeviceOffsets } from "./deviceOffsets";

const silent: ClickTrack = { start() {}, stop() {} };

function Demo(props: { calibrated?: boolean; stale?: boolean }) {
  const [offsets, setOffsets] = useState<DeviceOffsets>(props.calibrated ? { audio: 23, visual: -8 } : { audio: 0, visual: 0 });
  const [calibrated, setCalibrated] = useState(!!props.calibrated);
  return (
    // Inside a container-query bar 40px tall, as in the Studio header (the S-03 trap for fixed popovers).
    <div style={{ display: "flex", justifyContent: "flex-end", containerType: "inline-size", height: "40px", alignItems: "center" }}>
      <AudioDeviceMenu
        deviceName="System output · Speakers (Realtek)"
        offsets={offsets}
        calibrated={calibrated}
        stale={props.stale}
        latencyMs={31}
        bufferMs={(256 / 48000) * 1000}
        sampleRate={48000}
        devices={[
          { id: "default", name: "System output · Speakers (Realtek)", current: true },
          { id: "hdmi", name: "TV · HDMI", current: false },
        ]}
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
    await userEvent.click(c.getByRole("button", { name: /not calibrated/ }));
    const menu = page().getByRole("dialog", { name: "Audio device" });
    await expect(canvasElement.contains(menu)).toBe(false);
    await expect(within(menu).getByRole("combobox", { name: "Output device" })).toHaveValue("default");
    await expect(within(menu).getByText("256 samples · 5.3 ms")).toBeVisible();
    const field = within(menu).getByLabelText("Audio offset");
    await expect(field).toHaveAttribute("placeholder", "—");
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
    await userEvent.click(page().getAllByRole("button", { name: "Calibrate…" })[0]);
    const dialog = page().getByRole("dialog", { name: "Calibrate audio offset" });
    await expect(dialog).toBeVisible();
    // S-03: drawn at the page's root, so it is laid out against the window, not inside the header.
    await expect(dialog.getBoundingClientRect().width).toBeGreaterThan(300);
    await userEvent.keyboard("{Escape}");
    await expect(page().queryByRole("dialog", { name: "Calibrate audio offset" })).toBeNull();
  },
};
