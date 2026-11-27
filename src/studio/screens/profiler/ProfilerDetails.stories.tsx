// Stories (ADR 0219, 0348) for the Profiler's side panels and its Record button: At cursor over the fixture capture's
// keyframe (Music ducked), the Voice panel for a stolen and a missing voice, Why it played with its note, Messages in
// time order with a click picking a row, the empty states, and Record offered, blocked and recording.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { DockLayout } from "../../../editor/layout/DockLayout";
import { screenDock } from "../../shell/studioPanels";
import { profilerPanels } from ".";
import "../../studio.css";
import { namesFromStart } from "../../../plugins/audio/runtime/capture/testSupport";
import { GEN_CLIP_ID_FIRST } from "../../../plugins/audio/runtime/wire.generated";
import { buildMessages } from "./messagesModel";
import { AtCursor, MessageList, ReplayOrigin, VoiceDetails, WhyItPlayed } from "./ProfilerDetails";
import { RecordButton } from "./RecordButton";
import { buildVoices } from "./voiceModel";
import type { CaptureEventAt } from "../../../plugins/audio/runtime/capture/reader";
import "./profiler.css";

/** The screen's panel list, with a stand-in for the Take screen (the dock story draws only titles). */
const PROFILER_PANELS = profilerPanels({ openPath: () => undefined, Transport: () => null });

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
    await expect(c.getByRole("table", { name: /^Buses at the cursor/ })).toBeVisible();
    // The reason follows the bus's name; values are the level you hear, the loudness over its target is flagged.
    await expect(canvasElement.querySelector('[data-bus="Music"]')!.textContent).toMatch(/^Music ducked[-−]12\.0$/);
    await expect(c.getByText(/^[-−]21\.4$/)).toHaveClass("over");
    // The keys' hint lives in the tooltip, not on screen.
    await expect(c.queryByText(/step/)).toBeNull();
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

/** ADR 0360: a generator voice (its clip is the blip's reserved id) shows its kind. */
const blipClip = GEN_CLIP_ID_FIRST + 3;
const blipVoice = buildVoices(
  [{ seq: 1, seconds: 1, event: { perfMs: 0, type: "voiceStart", voice: 9, clip: blipClip, slot: 1, busGen: 0, flags: 0, atFrameLo: 0, gain: 0.5 } }],
  namesFromStart({ clips: [[blipClip, "audio/ui/coin.generator.json"]], buses: [[1, "UI"]] }),
  { start: 0, duration: 2 },
)[0]!;
export const GeneratorVoice: Story = {
  render: () => (
    <div style={{ width: "320px" }}>
      <VoiceDetails voice={blipVoice} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("img", { name: "Blip generator" })).toHaveTextContent("BLP");
    await expect(c.getByText("audio/ui/coin.generator.json", { exact: false })).toBeVisible();
  },
};
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
    // The chain is a graph of typed nodes; the bus node opens the Mixer on that bus.
    const graph = c.getByRole("list", { name: `Why ${stolen.clipName} played` });
    await expect(within(graph).getAllByRole("listitem").map((n) => n.querySelector(".pf-wn-kind")?.textContent)).toEqual(["SAMPLE", "BUS"]);
    await userEvent.click(within(graph).getByRole("button", { name: /^BUS Vehicles/ }));
    await expect(openStep).toHaveBeenCalledWith("mixer", "Vehicles");
    // Without the request in the capture the chain is partial, and the tip says why.
    await expect(c.getByText(/Partial chain/)).toBeVisible();
    // The zoom toolbar: + zooms in from the fitted scale.
    const pct = c.getByRole("button", { name: /%$/ });
    const before = pct.textContent;
    await userEvent.click(c.getByRole("button", { name: "Zoom in" }));
    await expect(pct.textContent).not.toBe(before);
    await userEvent.click(pct);
    await expect(pct.textContent).toBe("100%");
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

/** J10.4: a warning about a bus links to the Mixer with that bus selected; notes and markers don't. */
const openBus = fn();
export const MessagesOpenInMixer: Story = {
  render: () => (
    <div style={{ width: "520px" }}>
      <MessageList open selected={null} onPick={() => {}} onOpenBus={openBus} messages={buildMessages({ voices, markers: [{ time: 5, text: "Boss spawned" }] })} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const links = c.getAllByRole("button", { name: "Open in Mixer ›" });
    await expect(links.length).toBe(buildMessages({ voices }).filter((m) => m.bus).length);
    await userEvent.click(links[0]!);
    await expect(openBus).toHaveBeenCalledWith(stolen.busName);
  },
};

const openVoiceBus = fn();
export const StolenVoiceOpenInMixer: Story = {
  render: () => (
    <div style={{ width: "320px" }}>
      <VoiceDetails voice={stolen} onOpenBus={openVoiceBus} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Open in Mixer ›" }));
    await expect(openVoiceBus).toHaveBeenCalledWith(stolen.busName);
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
  render: () => <ReplayOrigin take={{ path: "recordings/HoverBike/canyon_run_01.sporesample", audioHash: "5f3a90c1" }} onOpenTake={openTake} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("canyon_run_01.sporesample")).toBeVisible();
    const open = c.getByRole("button", { name: "Open in Take" });
    await expect(open).toHaveAttribute("title", "Open canyon_run_01 in Take at the same playhead");
    await userEvent.click(open);
    await expect(openTake).toHaveBeenCalledWith("recordings/HoverBike/canyon_run_01.sporesample");
  },
};

/** The project doesn't have the take the replay capture names: no "Open in Take" to a take that isn't there. */
export const ReplayOfAMissingTake: Story = {
  render: () => <ReplayOrigin take={{ path: "recordings/gone.sporesample", audioHash: "5f3a90c1" }} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("gone.sporesample")).toBeVisible();
    await expect(c.queryByRole("button", { name: "Open in Take" })).toBeNull();
  },
};

export const DefaultDock: Story = {
  render: () => {
    // The screen's real panel list and default layout, each panel's view a stand-in (the views need the running app).
    const dock = screenDock("profiler", PROFILER_PANELS.map((p) => ({ ...p, view: () => <p>{p.title}</p> })));
    dock.store.reset();
    return (
      <div class="studio" style={{ width: "1400px", height: "800px", gridTemplateRows: "1fr", gridTemplateAreas: '"main"' }}>
        <main class="studio-dock">
          <DockLayout host={dock.host} view={(type) => dock.panels.get(type)?.view() ?? null} />
        </main>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByRole("tab", { name: "At cursor" }).closest<HTMLElement>(".dock-tabs")!.clientWidth).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 200));
    // Spec §4.6.1: At cursor and Voice on the right, Why it played below beside Messages; every tab shows whole.
    const dockOf = (title: string) => c.getByRole("tab", { name: title }).closest(".dock-group")?.className;
    await expect(dockOf("Voice")).toBe(dockOf("At cursor"));
    await expect(dockOf("Why it played")).toBe(dockOf("Messages"));
    await expect(dockOf("Why it played")).not.toBe(dockOf("Voice"));
    for (const p of PROFILER_PANELS) await expect(c.getByRole("tab", { name: p.title })).toBeVisible();
    await expect(c.queryByRole("button", { name: "More tabs" })).toBeNull();
  },
};
