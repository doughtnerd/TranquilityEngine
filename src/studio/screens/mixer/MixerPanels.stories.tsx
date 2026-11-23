// Stories (ADR 0219, 0344) for the Mixer screen's panels over fixture projects (the prototype's mix, and an empty
// project with Master only): the Buses panel in List and Strips views with the live board, editing a snapshot (faders
// write its offsets, the base level as a ghost tick), running with meters, the Inspector for a bus, a return and a
// VCA with a snapshot's effect overrides, the Snapshots tree, the Trigger dialog with conditions and overlaps, and the
// Gain lanes, Game parameters, Global parameters and Loudness panels, and Automate ◆ opening the shared curve editor.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useMemo } from "preact/hooks";
import { expect, userEvent, within } from "storybook/test";
import { UndoToasts } from "../../../editor/ui/UndoToast";
import { createToastQueue } from "../../../editor/ui/undoToastModel";
import type { AudioProject } from "../../../engine/audio/project/types";
import { BusesPanel } from "./BusesPanel";
import { MixerInspector } from "./MixerInspector";
import { emptyMix, mixerFixture } from "./mixerFixture";
import type { MixerSession } from "./mixerScreen";
import { fakeMixer, type FakeOptions } from "./mixerStoryData";
import { GainLanesPanel, LoudnessPanel, ParametersPanel } from "./SidePanels";
import { GlobalParametersPanel } from "./GlobalParametersPanel";
import { sessionParametersHost } from "./globalParametersHost";
import { SnapshotsPanel } from "./SnapshotsPanel";
import { TriggerDialog, TriggerDialogHost } from "./TriggerDialog";
import "../../components/audioParts.css";
import "../../components/studioComponents.css";
import "./mixer.css";

type Which = "buses" | "inspector" | "snapshots" | "trigger" | "gain" | "parameters" | "globalParameters" | "loudness";

interface ScreenArgs {
  readonly which: Which;
  readonly project?: () => AudioProject;
  readonly options?: FakeOptions;
  readonly setup?: (s: MixerSession) => void;
  readonly width?: number;
}

const toasts = createToastQueue();

function Screen(props: ScreenArgs) {
  const session = useMemo(() => {
    const f = fakeMixer((props.project ?? mixerFixture)(), { ...props.options, extra: { ...props.options?.extra, toast: (t) => void toasts.show(t) } });
    props.setup?.(f.session);
    return f.session;
  }, []);
  const p = session.project.value;
  return (
    <div style={{ width: `${props.width ?? 900}px`, height: "560px", display: "flex", flexDirection: "column", overflow: "auto" }}>
      {props.which === "buses" && <BusesPanel session={session} />}
      {props.which === "inspector" && <MixerInspector session={session} />}
      {props.which === "snapshots" && <SnapshotsPanel session={session} />}
      {props.which === "trigger" && <TriggerDialog session={session} snapshot={p.snapshots.find((s) => s.name === "Underwater")!} onClose={() => {}} />}
      {props.which === "gain" && <GainLanesPanel session={session} />}
      {props.which === "parameters" && <ParametersPanel session={session} />}
      {props.which === "globalParameters" && <GlobalParametersPanel host={sessionParametersHost(session)} />}
      {props.which === "loudness" && <LoudnessPanel session={session} />}
      <TriggerDialogHost />
      <UndoToasts queue={toasts} />
    </div>
  );
}

const meta = { title: "Studio/Mixer/Screen", component: Screen } satisfies Meta<ScreenArgs>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BusesList: Story = {
  args: { which: "buses" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const list = c.getByRole("listbox", { name: "Buses" });
    await expect(within(list).getAllByRole("option").map((o) => o.getAttribute("data-bus-row"))).toEqual(["Master", "SFX", "Vehicles", "Engine", "Footsteps", "Weapons", "Ambience", "Rain", "Dialogue", "Music", "UI"]);
    await expect(c.getByText("Beds 2/2 · 1 sharing")).toBeTruthy();
    await expect(c.getByText("Lost · shares Ambience")).toBeTruthy();
    await userEvent.click(c.getByRole("button", { name: "Collapse SFX" }));
    await expect(within(list).queryByText("Engine")).toBeNull();
  },
};

export const BusesStrips: Story = { args: { which: "buses", setup: (s) => void (s.view.value = "strips") } };

export const EditingASnapshot: Story = {
  args: { which: "buses", setup: (s) => s.editSnapshot("Underwater") },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("slider", { name: "Music level" })).toHaveAttribute("aria-valuenow", "-16");
  },
};

/** A snapshot edited on a bus under a VCA that isn't at 0 dB: the base-level tick and the VCA tick together. */
export const SnapshotWithVcaTicks: Story = {
  args: {
    which: "buses",
    project: () => {
      const p = mixerFixture();
      return { ...p, vcas: p.vcas.map((v) => (v.name === "Gameplay SFX" ? { ...v, volumeDb: -4 } : v)) };
    },
    setup: (s) => s.editSnapshot("Underwater"),
  },
  play: async ({ canvasElement }) => {
    const row = canvasElement.querySelector('[data-bus-row="Footsteps"]')!;
    await expect(row.querySelector(".studio-fader-ghost.vca")).toHaveAttribute("title", "With VCAs: -22.0 dB");
    await expect(row.querySelector(".studio-fader-ghost.base")).toHaveAttribute("title", "Base level: -6.0 dB");
  },
};

/** Automate ◆ on an effect opens the shared curve editor on every lane of the bus. */
export const AutomateOpensCurves: Story = {
  args: { which: "inspector", width: 360, setup: (s) => s.select("Ambience") },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Automate Low-pass" }));
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog");
    await expect(dialog).toHaveTextContent("Low-pass cutoff");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  },
};

export const LiveWithMeters: Story = {
  args: {
    which: "buses",
    options: { running: true, readings: { Master: { volume: 1, duckGain: 1, peak: 0.7, activeVoices: 6 }, Music: { volume: 1, duckGain: 0.5, peak: 0.3, activeVoices: 2 }, SFX: { volume: 1, duckGain: 1, peak: 0.9, activeVoices: 4 } } },
  },
};

export const EmptyProject: Story = { args: { which: "buses", project: emptyMix } };

export const InspectorBus: Story = { args: { which: "inspector", width: 360, setup: (s) => s.select("Dialogue") } };

export const InspectorSnapshotOverrides: Story = {
  args: { which: "inspector", width: 360, setup: (s) => { s.select("Ambience"); s.editSnapshot("Underwater"); } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("group", { name: "Overrides in Underwater" })).toBeTruthy();
    await userEvent.click(c.getByRole("button", { name: "Clear override" }));
    await expect(c.queryByRole("group", { name: "Overrides in Underwater" })).toBeNull();
  },
};

export const InspectorReturn: Story = { args: { which: "inspector", width: 360, setup: (s) => s.select("Reverb") } };
export const InspectorVca: Story = { args: { which: "inspector", width: 360, setup: (s) => s.select("Gameplay SFX") } };

export const Snapshots: Story = {
  args: { which: "snapshots", width: 280, setup: (s) => s.setTestValue("depth", 4) },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByText("Underwater"));
    await expect(c.getByRole("treeitem", { name: /Underwater/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.type(c.getByRole("searchbox", { name: "Search snapshots" }), "health");
    await expect(c.getByRole("tree", { name: "Matching snapshots" })).toBeTruthy();
  },
};

export const Trigger: Story = {
  args: { which: "trigger", setup: (s) => s.setTestValue("depth", 2) },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement.ownerDocument.body);
    await expect(c.getByRole("status")).toHaveTextContent("True now with the test values");
    await expect(c.getByRole("list", { name: "Overlapping snapshots" })).toHaveTextContent("Pause menu wins (priority 40 over 20).");
  },
};

export const GainLanesOfABus: Story = { args: { which: "gain", width: 300, setup: (s) => { s.select("Music"); s.editSnapshot("Underwater"); s.setTestValue("threat", 1); } } };
export const GameParameters: Story = { args: { which: "parameters", width: 320 } };

export const GlobalParameters: Story = {
  args: { which: "globalParameters", width: 340 },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole("group", { name: "Parameter depth" })).toBeTruthy();
    await expect(c.getByRole("button", { name: "Remove parameter threat" }).getAttribute("title")).toContain("2 automation lanes");
    await userEvent.click(c.getByRole("button", { name: "+ Parameter" }));
    await expect(c.getByRole("group", { name: "Parameter Parameter" })).toBeTruthy();
  },
};
export const LoudnessNotPlaying: Story = { args: { which: "loudness" } };
export const LoudnessPlaying: Story = { args: { which: "loudness", options: { running: true, loudness: { momentary: -14.2, shortTerm: -15.8, integrated: -16.4, lra: 7.2, maxTruePeak: -0.6, tainted: false } } } };
