// Stories (ADR 0219, 0349) for the Samples timeline's tools over a live sample block: Tempo with the Tap tempo dialog,
// Root note with validation, Normalize with the clip warning, the Snap split button and the Time display caret.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { defaultSampleEdits } from "../../../engine/audio/sample/format";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import type { TimeFormat } from "../../components/timeRulerModel";
import type { SampleDetection } from "../../../engine/audio/sample/detect/detect";
import type { SampleEdit } from "./sampleEditing";
import { detectedEdit } from "./sampleDetectModel";
import { NormalizePopover, RootPopover, SnapSplit, TempoPopover, TimeDisplayCaret, type DetectRun } from "./SampleTools";
import type { SnapSetting } from "./sampleView";

/** What the analysers "find" in the story's sample (the screen runs them on a worker over the decoded audio). */
const FOUND: SampleDetection = {
  tempo: { bpm: 128, confidence: 0.9, candidates: [{ bpm: 64, confidence: 0.55, relation: "half" }, { bpm: 256, confidence: 0.3, relation: "double" }], map: [] },
  root: { note: "A3", midi: 57, cents: -12, hz: 216.46, confidence: 0.95 },
};

function Tools() {
  const [e, setE] = useState<SampleEdits>({ ...defaultSampleEdits("music"), tempo: { bpm: 120, meter: "4/4", map: [], source: "file" } });
  const [snap, setSnap] = useState<SnapSetting>({ on: true, unit: "ms", step: 10 });
  const [fmt, setFmt] = useState<TimeFormat>("timecode");
  const commit = (r: SampleEdit) => "next" in r && setE(r.next);
  // The screen's `detectInto` with the analysis stood in for: the same edit model, committed the same way.
  const detect: DetectRun = async (kind) => {
    const r = detectedEdit(e, FOUND, [kind], "demand");
    if ("refused" in r) return { result: FOUND, applied: false, refused: r.refused };
    commit(r);
    return { result: FOUND, applied: true };
  };
  return (
    <div style={{ display: "flex", gap: "6px", padding: "8px", alignItems: "center" }}>
      <TempoPopover edits={e} commit={commit} detect={detect} />
      <RootPopover edits={e} commit={commit} detect={detect} />
      <NormalizePopover edits={e} measured={{ integrated: -19.5, peak: -2 }} bextLoudness={-24} commit={commit} />
      <SnapSplit snap={snap} zero={e.snapToZero} format={fmt} hasTempo={!!e.tempo} onSnap={setSnap} onZero={(on: boolean) => setE({ ...e, snapToZero: on })} />
      <span>{fmt}</span>
      <TimeDisplayCaret value={fmt} at={0.468} ctx={{ rate: 48000, bpm: e.tempo?.bpm, meter: e.tempo?.meter }} onChange={setFmt} />
    </div>
  );
}

const meta: Meta<typeof Tools> = { title: "Studio/Samples/Toolbar", component: Tools };
export default meta;
type Story = StoryObj<typeof Tools>;

export const Popovers: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const page = within(document.body);
    await userEvent.click(c.getByRole("button", { name: "Normalize" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "Loudness" }));
    await expect(page.getByText(/\+3\.5 dB/)).toBeVisible();
    await expect(page.getByRole("alert")).toHaveTextContent("Peaks would reach +1.5 dBFS and clip");
    await userEvent.keyboard("{Escape}");
    // The Snap split: the left half turns snapping off and on; the caret offers the increments.
    await userEvent.click(c.getByRole("button", { name: "Snap" }));
    await expect(c.getByRole("button", { name: "Snap" })).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(c.getByRole("button", { name: "Snap settings" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "100 ms" }));
    await expect(c.getByRole("button", { name: "Snap" })).toHaveTextContent("100 ms");
    await expect(c.getByRole("button", { name: "Snap" })).toHaveAttribute("aria-pressed", "true");
  },
};

/** The Time display caret: each format with a live example; picking one changes the display. */
export const TimeDisplay: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const page = within(document.body);
    await userEvent.click(c.getByRole("button", { name: "Time display…" }));
    await expect(page.getByRole("menuitemradio", { name: /Samples/ })).toHaveTextContent(/22.464/); // the locale's thousands separator
    await userEvent.click(page.getByRole("menuitemradio", { name: /Samples/ }));
    await expect(c.getByText("samples")).toBeVisible();
  },
};

/** Tap tempo: four taps a steady 500 ms apart give 120 BPM, and Use sets it. */
export const TapTempo: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const page = within(document.body);
    await userEvent.click(c.getByRole("button", { name: "Tempo and meter" }));
    await userEvent.click(page.getByRole("button", { name: "Tap" }));
    const dialog = page.getByRole("dialog", { name: "Tap tempo" });
    await expect(dialog).toBeVisible();
    await expect(within(dialog).getByRole("button", { name: "Use" })).toBeDisabled();
    for (let i = 0; i < 3; i++) {
      await userEvent.click(within(dialog).getByRole("button", { name: "Tap" }));
      await new Promise((r) => setTimeout(r, 400));
    }
    await userEvent.click(within(dialog).getByRole("button", { name: "Tap" }));
    const use = within(dialog).getByRole("button", { name: /^Use \d/ });
    await expect(use).toBeEnabled();
    await userEvent.click(use);
    await expect(page.queryByRole("dialog", { name: "Tap tempo" })).toBeNull();
  },
};

/** Detect in the Tempo and Root note popovers: enabled, the value lands marked Detected, half and double are offered. */
export const Detect: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const page = within(document.body);
    await userEvent.click(c.getByRole("button", { name: "Tempo and meter" }));
    const detectTempo = page.getByRole("menuitem", { name: "Detect" });
    await expect(detectTempo).toBeEnabled();
    await userEvent.click(detectTempo);
    await expect(await page.findByText("Detected 128 BPM · 90 % sure")).toBeVisible();
    await expect(page.getByText("Detected", { exact: true })).toBeVisible(); // the Source chip
    await expect(c.getByRole("button", { name: "Tempo and meter" })).toHaveTextContent("128");
    await userEvent.click(page.getByRole("button", { name: /½× 64 BPM/ }));
    await expect(c.getByRole("button", { name: "Tempo and meter" })).toHaveTextContent("64");

    await userEvent.click(c.getByRole("button", { name: "Root note" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Detect" }));
    await expect(await page.findByText(/Detected A3 −12 ct/)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Root note" })).toHaveValue("A3");
    await expect(c.getByRole("button", { name: "Root note" })).toHaveTextContent("A3 -12");
  },
};
