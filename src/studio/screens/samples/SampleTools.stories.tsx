// Stories (ADR 0219, 0335) for the Samples toolbar's popovers over a live sample block: Tempo with Tap tempo, Root
// note with validation, Normalize with the clip warning, Snap and the Time display.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { defaultSampleEdits } from "../../../engine/audio/sample/format";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import type { TimeFormat } from "../../components/timeRulerModel";
import type { SampleEdit } from "./sampleEditing";
import { NormalizePopover, RootPopover, SnapPopover, TempoPopover, TimeFormatPopover } from "./SampleTools";
import type { SnapSetting } from "./sampleView";

function Tools() {
  const [e, setE] = useState<SampleEdits>({ ...defaultSampleEdits("music"), tempo: { bpm: 120, meter: "4/4", map: [], source: "file" } });
  const [snap, setSnap] = useState<SnapSetting>({ on: true, unit: "ms", step: 10 });
  const [fmt, setFmt] = useState<TimeFormat>("timecode");
  const commit = (r: SampleEdit) => "next" in r && setE(r.next);
  return (
    <div style={{ display: "flex", gap: "6px", padding: "8px" }}>
      <TempoPopover edits={e} commit={commit} />
      <RootPopover edits={e} commit={commit} />
      <NormalizePopover edits={e} measured={{ integrated: -19.5, peak: -2 }} bextLoudness={-24} commit={commit} />
      <SnapPopover snap={snap} zero={e.snapToZero} onSnap={setSnap} onZero={(on) => setE({ ...e, snapToZero: on })} />
      <TimeFormatPopover value={fmt} hasTempo={!!e.tempo} onChange={setFmt} />
    </div>
  );
}

const meta: Meta<typeof Tools> = { title: "Studio/Samples/Toolbar", component: Tools };
export default meta;
type Story = StoryObj<typeof Tools>;

export const Popovers: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Normalize" }));
    await userEvent.click(within(document.body).getByRole("radio", { name: "Loudness" }));
    await expect(within(document.body).getByText(/Gain \+3\.5 dB/)).toBeVisible();
    await expect(within(document.body).getByRole("alert")).toHaveTextContent("Peaks would reach +1.5 dBFS and clip");
  },
};
