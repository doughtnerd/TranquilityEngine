// Stories (ADR 0219) for the Mixer panel as registered (Mp2b; ADR 0173): a strip per bus, the snapshot buttons, the
// loudness target picker, Reset, Pause and the elapsed time, Compare with Play start, every banner, the not-playing
// note, a strip's solo through the monitor, and a fader drag committing one undo step in the Project Settings history.
// The panel is loaded as the shell loads it (`registerMixPanels`, then its `view()`) over an in-memory project and its
// real deps; the play mixer, the audio clock, the loudness target and hub, and the capture marker are spied on their
// public surfaces so a play can read what the panel asked of them. The same cases run headless in
// mixerPanelView.test.ts and mixerSettings.test.ts until the story tests have run green.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, spyOn, userEvent, waitFor, within } from "storybook/test";
import { editor, type EditorPluginContext, type SettingsDraft } from "../../../../editor/sdk";
import { MemoryFileSystem } from "../../../../editor/memoryFs";
import { openFolderProject, type EditorProject } from "../../../../editor/projects";
import { currentProject, playState } from "../../../../editor/state";
import { reasonMessage } from "../../../../engine/audio/busCapability";
import { EMPTY_BUS_LOUDNESS, type LoudnessResetWhat } from "../../../../engine/audio/loudnessTypes";
import { mixer, type Bus, type MonitorControls } from "../../../../engine/audio/mixer";
import { applyOpToSettings, type MixOp } from "../../../../engine/audio/mixOps";
import { parseAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import type { AudioCapture } from "../../runtime/capture/capture";
import { Audio } from "../../runtime/Audio";
import { loudnessHub } from "../../runtime/mix/loudnessHub";
import { registerMixPanels } from "./index";
import { MixerPanel, mixerHost } from "./MixerPanel";
import { NOT_PLAYING } from "./mixerPanelModel";
import { startOpLog, type OpLogEntry } from "./opLog";

// The banners' words.
const MIXER_BANNER_TEXT = {
  monitor: "Monitor controls are on: the loudness target check is suspended and the meters are marked. They are never saved.",
  compare: "Compare: you are hearing the saved mix from Play start. The faders are locked and nothing is saved.",
} as const;

const AUDIO = {
  buses: [{ name: "master" }, { name: "sfx", parent: "master" }, { name: "music", parent: "master", volume: 0.8, meter: "loudness" }],
  snapshots: [{ name: "Paused", volumes: { music: 0.3 } }, { name: "Menu", volumes: { sfx: 0.5 } }],
  ducking: [{ target: "music", trigger: "sfx", mode: "level", amount: 0.4, attack: 0.1, release: 0.3, threshold: -30 }],
  loudnessTargets: [
    { name: "console", integrated: -24, tolerance: 2, truePeak: -1 },
    { name: "mobile", integrated: -18, tolerance: 2, truePeak: -1 },
    { name: "broadcast", integrated: -23, tolerance: 1, truePeak: -2 },
  ],
};

/** What the panel asked of the play engine in the running story, answered by a live mix the ops are applied to. */
interface Engine {
  project: EditorProject;
  log: { applied: MixOp[]; flushes: number; monitors: Array<[string, MonitorControls]>; marks: string[]; hub: string[]; targets: Array<string | null>; snapshots: Array<string | null>; entries: OpLogEntry[] };
  live(): AudioSettings;
  /** Advance the audio clock by `s` seconds. */
  advance(s: number): void;
  liveVolume(bus: string): number;
}
let engine: Engine | null = null;
const rig = (): Engine => engine!;

/** The Mixer panel's view, loaded as the shell loads it: `registerMixPanels` then the panel's `view()`. */
async function loadMixerPanel(): Promise<void> {
  const views = new Map<string, () => Promise<unknown>>();
  registerMixPanels({ registerPanel: (p: { id: string; view: () => Promise<unknown> }) => void views.set(p.id, p.view) } as unknown as EditorPluginContext);
  await views.get("audiomixer")!();
}

/** Open a project with `audio` in memory, load the panel and spy on the engine it talks to. Returns the cleanup. */
async function openRig(audio: unknown): Promise<() => void> {
  const fs = new MemoryFileSystem();
  fs.files.set("C:\\Games\\mix\\project.json", JSON.stringify({ name: "Game", audio }, null, 2));
  const project = await openFolderProject(fs, "C:\\Games\\mix");
  currentProject.value = project;
  await loadMixerPanel();
  let live: AudioSettings = parseAudioSettings(audio).settings;
  let snapshot: string | null = null;
  let target: string | null = null;
  let clock = 0;
  let heardSfx: number | null = null;
  const log: Engine["log"] = { applied: [], flushes: 0, monitors: [], marks: [], hub: [], targets: [], snapshots: [], entries: [] };
  const loudness = { ...EMPTY_BUS_LOUDNESS, reset: (what: LoudnessResetWhat) => void log.hub.push(`reset:${what}`), pause: () => void log.hub.push("pause"), resume: () => void log.hub.push("resume") };
  const spies = [
    spyOn(mixer, "busNames", "get").mockImplementation(() => live.buses.map((b) => b.name)),
    spyOn(mixer, "bus").mockImplementation((name = "master") => ({
      exists: live.buses.some((b) => b.name === name), volume: name === "sfx" && heardSfx !== null ? heardSfx : 1, mute: false, solo: false, peak: 0, effectiveGain: 1, duckGain: 1, activeVoices: 0, loudness,
    }) as unknown as Bus),
    spyOn(mixer, "apply").mockImplementation((op: MixOp) => {
      log.applied.push(op);
      live = applyOpToSettings(live, op);
      if (op.op === "setBus" && op.bus === "sfx" && op.key === "volume") heardSfx = op.value === null ? 1 : (op.value as number);
      return { ok: true, class: "direct" };
    }),
    spyOn(mixer, "setMonitor").mockImplementation((bus, c) => void log.monitors.push([bus, c])),
    spyOn(mixer, "snapshot").mockImplementation((name) => { snapshot = name; log.snapshots.push(name); }),
    spyOn(mixer, "clearSnapshot").mockImplementation(() => { snapshot = null; log.snapshots.push(null); }),
    spyOn(mixer, "currentSnapshot", "get").mockImplementation(() => snapshot),
    spyOn(Audio, "loudnessTarget", "get").mockImplementation(() => target),
    spyOn(Audio, "loudnessTarget", "set").mockImplementation((n) => { target = n; log.targets.push(n); }),
    spyOn(Audio, "time", "get").mockImplementation(() => clock),
    spyOn(Audio, "capture", "get").mockImplementation(() => ({ mark: (t: string) => void log.marks.push(t) }) as unknown as AudioCapture),
    spyOn(loudnessHub, "noteMonitorMute").mockImplementation((b) => void log.hub.push(`mute:${b}`)),
    spyOn(loudnessHub, "noteMonitorSolo").mockImplementation(() => void log.hub.push("solo")),
    spyOn(loudnessHub, "setMonitorActive").mockImplementation((on) => void log.hub.push(`active:${on}`)),
    spyOn(loudnessHub, "setCompare").mockImplementation((on) => void log.hub.push(`compare:${on}`)),
  ];
  const host = { flushNow: mixerHost.flushNow, entries: mixerHost.entries };
  mixerHost.flushNow = () => void log.flushes++;
  mixerHost.entries = () => log.entries;
  engine = {
    project,
    log,
    live: () => live,
    advance: (s) => void (clock += s),
    liveVolume: (bus) => live.buses.find((b) => b.name === bus)!.volume,
  };
  return () => {
    for (const s of spies) s.mockRestore();
    Object.assign(mixerHost, host);
    playState.value = "edit";
    currentProject.value = null;
    engine = null;
  };
}

/** Start Play: the panel samples on its own timer. */
const play = () => void (playState.value = "playing");
const snapshots = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>(".mixer-snapshot")];
const one = (root: HTMLElement, cls: string) => root.querySelector<HTMLElement>(`.${cls}`);

const meta = {
  title: "Audio/Mixer/Panel",
  component: MixerPanel,
  // A story's `parameters.audio` replaces the project's audio section.
  beforeEach: ({ parameters }) => openRig(parameters.audio ?? AUDIO),
} satisfies Meta<typeof MixerPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NotPlaying: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step("a strip per bus, in tree order", async () => {
      expect([...canvasElement.querySelectorAll<HTMLElement>("[role=group][data-bus]")].map((n) => n.dataset.bus)).toEqual(["master", "sfx", "music"]);
    });
    await step("the not-playing note and no banner list", async () => {
      expect(one(canvasElement, "mixer-empty")).toHaveTextContent(NOT_PLAYING);
      expect(one(canvasElement, "mixer-banners")).toBeNull();
    });
    await step("a button per snapshot, disabled outside Play; Compare disabled too", async () => {
      expect(snapshots(canvasElement).map((b) => b.textContent)).toEqual(["Paused", "Menu"]);
      expect(snapshots(canvasElement).every((b) => b.disabled)).toBe(true);
      expect(one(canvasElement, "mixer-compare")).toBeDisabled();
    });
    await step("the target picker has an option per target, the one in force selected; changing it sets Audio.loudnessTarget", async () => {
      const select = canvas.getByLabelText("Loudness target") as HTMLSelectElement;
      expect([...select.options].map((o) => o.value)).toEqual(["console", "mobile", "broadcast"]);
      expect(select.value).toBe("console");
      expect(select.options[2]!.textContent).toBe("broadcast (-23 LUFS ±1 LU, -2 dBTP)");
      await userEvent.selectOptions(select, "mobile");
      expect(rig().log.targets).toEqual(["mobile"]);
      await waitFor(() => expect((canvas.getByLabelText("Loudness target") as HTMLSelectElement).value).toBe("mobile"));
      expect(editor.project.settings.canUndo()).toBe(false); // never a commit
    });
  },
};

export const Playing: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    play();
    await waitFor(() => expect(one(canvasElement, "mixer-empty")).toBeNull());
    await step("the snapshot buttons are on in Play; a click picks one and it shows pressed", async () => {
      expect(snapshots(canvasElement).every((b) => !b.disabled)).toBe(true);
      await userEvent.click(snapshots(canvasElement)[1]!);
      expect(rig().log.snapshots).toEqual(["Menu"]);
      await waitFor(() => expect(snapshots(canvasElement).map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true"]));
    });
    await step("Reset, Pause (its pressed state and label) and the elapsed time", async () => {
      rig().advance(65);
      await waitFor(() => expect(one(canvasElement, "mixer-elapsed")).toHaveTextContent("1:05"));
      await userEvent.click(one(canvasElement, "mixer-reset")!);
      expect(rig().log.hub).toContain("reset:all");
      await waitFor(() => expect(one(canvasElement, "mixer-elapsed")).toHaveTextContent("0:00"));
      expect(one(canvasElement, "mixer-pause")).toHaveTextContent("Pause");
      expect(one(canvasElement, "mixer-pause")).toHaveAttribute("aria-pressed", "false");
      await userEvent.click(one(canvasElement, "mixer-pause")!);
      expect(rig().log.hub).toContain("pause");
      await waitFor(() => expect(one(canvasElement, "mixer-pause")).toHaveTextContent("Resume"));
      expect(one(canvasElement, "mixer-pause")).toHaveAttribute("aria-pressed", "true");
      await userEvent.click(one(canvasElement, "mixer-pause")!);
      expect(rig().log.hub).toContain("resume");
      await waitFor(() => expect(one(canvasElement, "mixer-pause")).toHaveTextContent("Pause"));
    });
    await step("a strip's solo goes through the monitor and commits nothing", async () => {
      await userEvent.click(canvas.getByLabelText("Solo sfx"));
      expect(rig().log.monitors).toEqual([["sfx", { solo: true }]]);
      expect(editor.project.settings.canUndo()).toBe(false);
    });
  },
};

export const Compare: Story = {
  beforeEach: () => startOpLog(() => mixer).dispose, // in Play, a committed edit reaches the play mixer through the op log
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    play();
    await waitFor(() => expect(one(canvasElement, "mixer-compare")).toBeEnabled());
    // The sfx fader to the bottom from the keyboard: one committed edit.
    canvas.getByLabelText("sfx volume").focus();
    await userEvent.keyboard("{Home}");
    await waitFor(() => expect(rig().liveVolume("sfx")).toBeLessThan(1));
    const edited = rig().liveVolume("sfx");
    expect(one(canvasElement, "mixer-compare")).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(one(canvasElement, "mixer-compare")!);
    await waitFor(() => expect(one(canvasElement, "mixer-compare")).toHaveAttribute("aria-pressed", "true"));
    expect(rig().liveVolume("sfx")).toBe(1); // the saved mix from Play start
    await userEvent.click(one(canvasElement, "mixer-compare")!);
    await waitFor(() => expect(one(canvasElement, "mixer-compare")).toHaveAttribute("aria-pressed", "false"));
    expect(rig().liveVolume("sfx")).toBe(edited);
    expect(rig().log.marks).toEqual(["Compare: saved mix (Play start)", "Compare: edited mix"]);
    expect(rig().log.hub.filter((x) => x.startsWith("compare:"))).toEqual(["compare:true", "compare:false"]);
  },
};

export const EveryBanner: Story = {
  // A bus whose effect this build doesn't know: a problem in the audio section.
  parameters: { audio: { ...AUDIO, buses: [{ name: "master" }, { name: "sfx", parent: "master", effects: [{ type: "nope" }] }, { name: "music", parent: "master", meter: "loudness" }] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    play();
    rig().log.entries.push({ seq: 1, cause: "edit", source: "recorded", ops: [], results: [{ ok: false, class: "direct", reason: "effectsPerBus" }], restartRequired: [] });
    await waitFor(() => expect(one(canvasElement, "mixer-compare")).toBeEnabled());
    await userEvent.click(canvas.getByLabelText("Solo music"));
    await userEvent.click(one(canvasElement, "mixer-compare")!);
    const byId = (id: string) => [...canvasElement.querySelectorAll<HTMLElement>(`.mixer-banner[data-banner="${id}"]`)];
    await waitFor(() => expect(byId("compare")).toHaveLength(1));
    expect(byId("problem").length).toBeGreaterThan(0);
    expect(byId("restart")[0]).toHaveTextContent(`Applies at the next Play: ${reasonMessage("effectsPerBus")}. The edit is saved.`);
    expect(byId("monitor")[0]).toHaveTextContent(MIXER_BANNER_TEXT.monitor);
    expect(byId("compare")[0]).toHaveTextContent(MIXER_BANNER_TEXT.compare);
    expect(byId("problem")[0]).toHaveAttribute("data-severity", "warn");
    expect(byId("problem")[0]).toHaveAttribute("role", "alert");
    expect(byId("restart")[0]).toHaveAttribute("data-severity", "info");
    expect(byId("restart")[0]).toHaveAttribute("role", "status");
  },
};

const sfxVolumeOf = (d: SettingsDraft): number | undefined => (d.audio as { buses: Array<{ name: string; volume?: number }> }).buses.find((b) => b.name === "sfx")!.volume;

export const FaderDrag: Story = {
  beforeEach: () => {
    play(); // the op log is live only while Play runs
    return startOpLog(() => mixer).dispose;
  },
  play: async ({ canvasElement }) => {
    const fader = within(canvasElement).getByLabelText("sfx volume");
    const top = fader.getBoundingClientRect().top;
    const at = (dy: number) => ({ clientY: top + dy, button: 0, pointerId: 1, isPrimary: true });
    await fireEvent.pointerDown(fader, at(5));
    await fireEvent.pointerMove(fader, at(15));
    await fireEvent.pointerMove(fader, at(25)); // down: quieter
    expect(editor.project.settings.canUndo()).toBe(false); // previews never enter the history
    const v = editor.project.settings.version;
    await fireEvent.pointerUp(fader, at(25));
    // Saved, one step in the Project Settings history, and heard.
    await waitFor(() => expect(sfxVolumeOf(JSON.parse(rig().project.textOf("project.json")!) as SettingsDraft)).toBeDefined());
    const g = sfxVolumeOf(editor.project.settings.draft())!;
    expect(g).toBeLessThan(1);
    expect(editor.project.settings.version).toBeGreaterThan(v);
    expect(mixer.bus("sfx").volume).toBeCloseTo(g, 9);
    expect(mixerHost.section!.history.name).toBe("Project Settings");
    expect(mixerHost.section!.history.canUndo).toBe(true);
    // The Mixer's Ctrl+Z (its history, the Project Settings one) undoes it; the heard value follows.
    mixerHost.section!.history.undo();
    await waitFor(() => expect(sfxVolumeOf(editor.project.settings.draft())).toBeUndefined());
    expect(mixer.bus("sfx").volume).toBe(1);
  },
};
