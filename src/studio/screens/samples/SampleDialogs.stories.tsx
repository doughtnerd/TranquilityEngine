// Stories (ADR 0219, 0349) for the Samples screen's reviews: Write to file…, the changed-on-disk merge (a conflict, a
// new cue, a loop end that moved), Fork as new sample, and the import review with the metadata kinds found.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, fn, userEvent, within } from "storybook/test";
import type { WavMetadata } from "../../../engine/audio/sample/wavChunks";
import { ImportReview } from "./ImportDialog";
import type { KindToggles } from "./importPlan";
import type { RemapMode } from "../../../engine/audio/sample/remap";
import { DeriveForm, MergeReview, WriteReview } from "./SampleDialogs";
import { ReimportReview } from "./ReimportDialog";
import type { MergeRow } from "./sampleFile";

const meta: Meta = { title: "Studio/Samples/Dialogs" };
export default meta;
type Story = StoryObj;

export const WriteToFile: Story = {
  render: () => (
    <WriteReview
      name="brake_skid.wav"
      rows={[
        { what: "2 cue points", chunks: "cue + labl + note" },
        { what: "0 regions", chunks: "ltxt" },
        { what: "1 loop", chunks: "smpl" },
        { what: "No tempo (removes acid)", chunks: "acid" },
        { what: "No root note", chunks: "smpl" },
      ]}
      keptInSidecar={1}
      onWrite={fn()}
      onCancel={fn()}
    />
  ),
  play: async () => {
    const c = within(document.body);
    await expect(c.getByRole("dialog", { name: "Write to brake_skid.wav" })).toBeVisible();
    await expect(c.getByText(/stay in the sidecar/)).toBeVisible();
  },
};

const rows: MergeRow[] = [
  { key: "cue:1", kind: "marker", title: "Moved cue", detail: "Lock-up: 0.320 s → 0.350 s", conflict: true, options: ["project", "file"], choice: "project", id: "m2" },
  { key: "cue:3", kind: "marker", title: "New cue", detail: "Stop at 2.000 s", conflict: false, options: ["add", "skip"], choice: "add" },
  { key: "smpl:0", kind: "loop", title: "Loop end moved", detail: "0.450 s – 1.550 s → 0.450 s – 1.500 s", conflict: false, options: ["project", "file"], choice: "file", id: "l1" },
];

export const ChangedOnDisk: Story = {
  render: () => <MergeReview name="brake_skid.wav" rows={rows} onApply={fn()} onLater={fn()} />,
  play: async () => {
    const c = within(document.body);
    await expect(c.getByText("1 conflict with project edits")).toBeVisible();
    await expect(c.getByText("You also changed this in the project.")).toBeVisible();
  },
};

function Fork() {
  const [name, setName] = useState("brake_skid_fork");
  const [folder, setFolder] = useState("audio");
  const [mode, setMode] = useState<"follow" | "pin">("follow");
  return (
    <DeriveForm kind="fork" parentName="brake_skid.wav" name={name} folder={folder} folders={["audio", "audio/sfx"]} mode={mode} edits={4}
      onName={setName} onFolder={setFolder} onMode={setMode} onCreate={fn()} onCancel={fn()} />
  );
}

export const ForkAsNewSample: Story = {
  render: () => <Fork />,
  play: async () => {
    const c = within(document.body);
    await userEvent.click(c.getByRole("radio", { name: "Pin to its current state" }));
    await expect(c.getByRole("radio", { name: "Pin to its current state" })).toHaveAttribute("aria-checked", "true");
    // The folder combo: type a new path and Enter makes it.
    await userEvent.click(c.getByRole("button", { name: /^Folder: audio/ }));
    await userEvent.type(c.getByRole("searchbox", { name: "Search folders or type a new one" }), "Props/Doors{Enter}");
    await expect(c.getByRole("button", { name: /^Folder: Props › Doors/ })).toBeVisible();
    await expect(c.getByRole("button", { name: "Fork" })).toBeEnabled();
  },
};

const door: WavMetadata = {
  sampleRate: 48000, frames: 144000, channels: 1, tempo: null, root: { midiNote: 48, cents: 0 },
  bext: { description: "", originator: "", originatorReference: "", originationDate: "", originationTime: "", timeReference: 172800000, version: 1, umid: "", loudnessValue: null, loudnessRange: null, maxTruePeakLevel: null, maxMomentaryLoudness: null, maxShortTermLoudness: null, codingHistory: "" },
  cues: [{ id: 1, frame: 4800, label: "Creak start", note: "" }, { id: 2, frame: 96000, label: "Latch", note: "" }],
  regions: [{ id: 3, frame: 9600, length: 48000, label: "Creak", note: "", purpose: "rgn ", text: "" }],
  loops: [{ cueId: 0, type: 0, start: 24000, end: 72000, fraction: 0, playCount: 0 }, { cueId: 0, type: 1, start: 80000, end: 90000, fraction: 0, playCount: 2 }],
};

function Review() {
  const [toggles, setToggles] = useState<KindToggles>({});
  const [into, setInto] = useState("audio");
  const [keep, setKeep] = useState(true);
  const [stream, setStream] = useState(false);
  return (
    <ImportReview
      files={[{ rel: "Doors/door_creak_02.wav", meta: door }, { rel: "Doors/door_slam.wav", meta: { ...door, cues: [], regions: [], loops: [], root: null, bext: null } }]}
      folders={["audio", "audio/sfx"]}
      toggles={toggles} into={into} keep={keep} stream={stream}
      onToggle={(k, on) => setToggles(k === "all" || k === "none" ? {} : { ...toggles, [k]: on })}
      onInto={setInto} onKeep={setKeep} onStream={setStream} onImport={fn()} onCancel={fn()}
    />
  );
}

export const ImportReviewStory: Story = {
  name: "Import review",
  render: () => <Review />,
  play: async () => {
    const c = within(document.body);
    await expect(c.getByText("Cue points")).toBeVisible();
    await expect(c.getByText("Timecode origin")).toBeVisible();
    await userEvent.click(c.getByRole("checkbox", { name: /Regions/ }));
    await expect(c.getByText(/5 of 6 kinds of metadata will be imported/)).toBeVisible(); // Detect counts too (T-15)
  },
};

/** The import review's "Detect what's missing" is enabled and on by default (ADR 0342 detection). */
export const ImportDetect: Story = {
  name: "Import review · Detect what's missing",
  render: () => <Review />,
  play: async () => {
    const c = within(document.body);
    const detect = c.getByRole("checkbox", { name: /Detect what's missing/ });
    await expect(detect).toBeEnabled();
    await expect(detect).toBeChecked();
    await userEvent.click(detect);
    await expect(detect).not.toBeChecked();
  },
};

function Reimport() {
  const [mode, setMode] = useState<RemapMode>("seconds");
  return (
    <ReimportReview
      name="door.wav" length={1.2} mode={mode} onMode={setMode}
      picked={{ name: "door_take2.wav", length: 0.8 }}
      versions={{ current: 2, versions: [
        { n: 1, file: "v1.wav", kind: "original", name: "door.wav", at: "2026-11-20T10:00:00Z", length: 1.4 },
        { n: 2, file: "v2.wav", kind: "reimport", name: "door_v2.wav", at: "2026-11-21T10:00:00Z", length: 1.2 },
      ] }}
      onPick={fn()} onImport={fn()} onRestore={fn()} onCancel={fn()}
    />
  );
}

export const ReimportStory: Story = {
  name: "Re-import",
  render: () => <Reimport />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("dialog", { name: "Re-import door.wav" })).toBeVisible();
    await expect(c.getByRole("alert")).toHaveTextContent("The new file is shorter");
    await userEvent.click(c.getByRole("radio", { name: "Scale to the new length" }));
    await expect(c.queryByRole("alert")).toBeNull();
    await expect(within(c.getByRole("list", { name: "Source versions" })).getByRole("button", { name: "Restore" })).toBeVisible();
  },
};
