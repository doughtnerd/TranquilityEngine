// Stories (ADR 0219, 0334) for the Profiler's side panels and its Record button: At cursor over the fixture capture's
// keyframe (Music ducked), the Voice panel for a stolen and a missing voice, Why it played with its note, Messages in
// time order with a click picking a row, the empty states, and Record offered, blocked and recording.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { namesFromStart } from "../../../plugins/audio/runtime/capture/testSupport";
import { buildMessages } from "./messagesModel";
import { AtCursor, MessageList, ReplayOrigin, VoiceDetails, WhyItPlayed } from "./ProfilerDetails";
import { RecordButton } from "./RecordButton";
import { buildVoices } from "./voiceModel";
import type { CaptureEventAt } from "../../../plugins/audio/runtime/capture/reader";
import "./profiler.css";

const names = namesFromStart({ clips: [[1, "impact_01.wav"], [2, "vo_rider_07.wav"]], buses: [[1, "Vehicles"], [2, "Dialogue"]] });
const events: CaptureEventAt[] = [
  { seq: 1, seconds: 3.2, event: { perfMs: 0, type: "voiceStart", voice: 4, clip: 1, slot: 1, busGen: 0, flags: 0, atFrameLo: 0, gain: 0.7 } },
  { seq: 2, seconds: 3.9, event: { perfMs: 0, type: "voiceSteal", voice: 4, thief: 7, reason: "busMaxVoices" } },
  { seq: 3, seconds: 6.5, event: { perfMs: 0, type: "voiceRefused", clip: 2, slot: 2, busGen: 0, reason: "loadFailed" } },
];
const voices = buildVoices(events, names, { start: 0, duration: 12 });
const stolen = voices[0]!;
const missing = voices[1]!;

const meta = { title: "Studio/Profiler/Details" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const AtCursorDucked: Story = {
  render: () => (
    <div style={{ width: "320px" }}>
      <AtCursor
        open
        time={5}
        loudness={{ name: "Master", lufs: -21.4, target: -24 }}
        readouts={[
          { slot: 1, name: "Music", db: -12, authoredDb: -6, lanes: [{ lane: "duck", reason: "ducked", db: -6 }], muted: false, removed: false },
          { slot: 2, name: "Vehicles", db: 0, authoredDb: 0, lanes: [], muted: false, removed: false },
        ]}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("table", { name: "Buses at the cursor" })).toBeVisible();
    await expect(canvasElement.querySelector('[data-bus="Music"]')!.textContent).toContain("ducked");
    await expect(c.getByText(/above target -24/)).toBeVisible();
  },
};

export const AtCursorEmpty: Story = { render: () => <AtCursor open={false} time={0} readouts={[]} /> };

export const StolenVoice: Story = {
  render: () => (
    <div style={{ width: "320px" }}>
      <VoiceDetails voice={stolen} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("Warning · Voice stolen")).toBeVisible();
    await expect(c.getByText("bus max voices", { exact: false })).toBeVisible();
    await expect(c.getByText("#4 (stolen for #7)")).toBeVisible();
  },
};

export const MissingFile: Story = { render: () => <VoiceDetails voice={missing} /> };
export const NoVoice: Story = { render: () => <VoiceDetails voice={null} /> };

const openStep = fn();
export const WhyItPlayedNote: Story = {
  render: () => (
    <div style={{ width: "360px" }}>
      <WhyItPlayed voice={stolen} onOpen={openStep} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Vehicles" }));
    await expect(openStep).toHaveBeenCalledWith("mixer", "Vehicles");
    await expect(c.getByText(/no decision path/)).toBeVisible();
  },
};

const pick = fn();
export const Messages: Story = {
  render: () => (
    <div style={{ width: "520px" }}>
      <MessageList open selected={stolen.key} onPick={pick} messages={buildMessages({ voices, markers: [{ time: 5, text: "Boss spawned" }], notes: [{ time: 6, text: "Music Explore → Combat" }] })} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const rows = c.getAllByRole("button");
    await expect(rows.map((r) => r.querySelector(".pf-msg-time")!.textContent)).toEqual(["0:03.9", "0:05.0", "0:06.0", "0:06.5"]);
    await expect(rows[0]).toHaveClass("selected");
    await userEvent.click(rows[3]!);
    await expect(pick).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", text: "Missing file vo_rider_07.wav" }));
  },
};

export const NoMessages: Story = { render: () => <MessageList open selected={null} onPick={() => {}} messages={[]} /> };

const toggle = fn();
export const RecordOffered: Story = {
  render: () => <RecordButton recording={false} busy={false} blocked={null} onToggle={toggle} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Record" }));
    await expect(toggle).toHaveBeenCalled();
  },
};
export const RecordBlocked: Story = {
  render: () => <RecordButton recording={false} busy={false} blocked="Nothing is playing: audition a playlist or replay a take, then record" onToggle={() => {}} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: "Record" })).toBeDisabled();
  },
};
export const Recording: Story = { render: () => <RecordButton recording busy={false} blocked={null} onToggle={() => {}} /> };

const openTake = fn();
export const ReplayCapture: Story = {
  render: () => <ReplayOrigin take={{ path: "takes/HoverBike/canyon_run_01.mycotake", audioHash: "5f3a90c1" }} onOpenTake={openTake} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("canyon_run_01.mycotake")).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Open in Take" }));
    await expect(openTake).toHaveBeenCalledWith("takes/HoverBike/canyon_run_01.mycotake");
  },
};
