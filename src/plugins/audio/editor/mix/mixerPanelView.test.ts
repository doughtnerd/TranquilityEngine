// The Mixer panel as registered (task Mp2b): `MixerPanel` rendered with its hooks (`testRender`, no DOM) over its real deps
// (the project's audio section through `mixerHost`, the play `mixer`, `Audio`, the loudness hub). The play mixer, the
// audio clock, the loudness target and the capture marker are spied on their public surfaces so the test can read
// what the panel asked of them; the strips, buttons, picker and banners are read from the rendered tree and driven
// through its handlers. Cases: a strip per bus, the snapshot buttons, the target picker, Reset, Pause and the elapsed
// time, Compare, every banner, the not-playing note, and a strip's solo through the monitor. No wall clock: the panel's
// sample timer is faked and the clock is the one the test advances.
import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editor, type EditorPluginContext } from "../../../../editor/sdk";
import { playState } from "../../../../editor/state";
import { closeTestProject, openTestProject } from "../../../../editor/testing";
import { byClass, find, render, text, type HostNode } from "../../../../editor/testRender";
import { reasonMessage } from "../../../../engine/audio/busCapability";
import { EMPTY_BUS_LOUDNESS, type LoudnessResetWhat } from "../../../../engine/audio/loudnessTypes";
import { mixer, type Bus, type MonitorControls } from "../../../../engine/audio/mixer";
import { applyOpToSettings, type ApplyResult, type MixOp } from "../../../../engine/audio/mixOps";
import { parseAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import type { AudioCapture } from "../../runtime/capture/capture";
import { Audio } from "../../runtime/Audio";
import { loudnessHub } from "../../runtime/mix/loudnessHub";
import { positionToGain } from "./faderModel";
import { registerMixPanels } from "./index";
import { MixerPanel, POLL_MS, mixerHost } from "./MixerPanel";
import { NOT_PLAYING } from "./mixerPanelModel";
import { startOpLog, type OpLogEntry } from "./opLog";

vi.mock("preact/hooks", () => import("../../../../editor/testRender"));

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

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
  vi.useRealTimers();
  playState.value = "edit";
  closeTestProject(); // `mixerHost.section` stays filled: the panel's module loads once, as in the editor
});

/** The Mixer panel's view, loaded as the shell loads it: `registerMixPanels` then the panel's `view()`. */
async function loadMixerPanel(): Promise<void> {
  const views = new Map<string, () => Promise<unknown>>();
  registerMixPanels({ registerPanel: (p: { id: string; view: () => Promise<unknown> }) => void views.set(p.id, p.view) } as unknown as EditorPluginContext);
  await views.get("audiomixer")!();
}

/** What the panel asks of the play engine, answered by a live mix the ops are applied to. */
function spyEngine(audio: unknown) {
  let live: AudioSettings = parseAudioSettings(audio).settings;
  let snapshot: string | null = null;
  let target: string | null = null;
  let clock = 0;
  const log = {
    applied: [] as MixOp[], flushes: 0, monitors: [] as Array<[string, MonitorControls]>, marks: [] as string[],
    hub: [] as string[], targets: [] as Array<string | null>, snapshots: [] as Array<string | null>, entries: [] as OpLogEntry[],
  };
  const answers = new Map<string, ApplyResult>();
  const loudness = { ...EMPTY_BUS_LOUDNESS, reset: (what: LoudnessResetWhat) => void log.hub.push(`reset:${what}`), pause: () => void log.hub.push("pause"), resume: () => void log.hub.push("resume") };
  vi.spyOn(mixer, "busNames", "get").mockImplementation(() => live.buses.map((b) => b.name));
  vi.spyOn(mixer, "bus").mockImplementation((name = "master") => ({
    exists: live.buses.some((b) => b.name === name), volume: 1, mute: false, solo: false, peak: 0, effectiveGain: 1, duckGain: 1, activeVoices: 0, loudness,
  }) as unknown as Bus);
  vi.spyOn(mixer, "apply").mockImplementation((op: MixOp) => {
    log.applied.push(op);
    live = applyOpToSettings(live, op);
    return answers.get(op.op) ?? { ok: true, class: "direct" };
  });
  vi.spyOn(mixer, "setMonitor").mockImplementation((bus, c) => void log.monitors.push([bus, c]));
  vi.spyOn(mixer, "snapshot").mockImplementation((name) => { snapshot = name; log.snapshots.push(name); });
  vi.spyOn(mixer, "clearSnapshot").mockImplementation(() => { snapshot = null; log.snapshots.push(null); });
  vi.spyOn(mixer, "currentSnapshot", "get").mockImplementation(() => snapshot);
  vi.spyOn(Audio, "loudnessTarget", "get").mockImplementation(() => target);
  vi.spyOn(Audio, "loudnessTarget", "set").mockImplementation((n) => { target = n; log.targets.push(n); });
  vi.spyOn(Audio, "time", "get").mockImplementation(() => clock);
  vi.spyOn(Audio, "capture", "get").mockImplementation(() => ({ mark: (t: string) => void log.marks.push(t) }) as unknown as AudioCapture);
  vi.spyOn(loudnessHub, "noteMonitorMute").mockImplementation((b) => void log.hub.push(`mute:${b}`));
  vi.spyOn(loudnessHub, "noteMonitorSolo").mockImplementation(() => void log.hub.push("solo"));
  vi.spyOn(loudnessHub, "setMonitorActive").mockImplementation((on) => void log.hub.push(`active:${on}`));
  vi.spyOn(loudnessHub, "setCompare").mockImplementation((on) => void log.hub.push(`compare:${on}`));
  return { log, live: () => live, advance: (s: number) => void (clock += s) };
}

/** The panel over a project with `audio`; Play starts and the clock advances as the test says, the panel sampling on its timer. */
async function rig(audio: unknown = AUDIO) {
  await openTestProject({ "project.json": JSON.stringify({ name: "Game", audio }) });
  await loadMixerPanel();
  const engine = spyEngine(audio);
  const host = { flushNow: mixerHost.flushNow, entries: mixerHost.entries };
  mixerHost.flushNow = () => void engine.log.flushes++;
  mixerHost.entries = () => engine.log.entries;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const panel = render(() => h(MixerPanel, {}));
  cleanups.push(() => {
    panel.unmount();
    Object.assign(mixerHost, host);
  });
  const tree = (): unknown => panel.tree();
  tree();
  const sample = () => vi.advanceTimersByTime(POLL_MS);
  return {
    ...engine,
    tree,
    play: () => { playState.value = "playing"; sample(); },
    advance: (s: number) => { engine.advance(s); sample(); },
    liveVolume: (bus: string): number => engine.live().buses.find((b) => b.name === bus)!.volume,
  };
}

const click = (n: HostNode): void => (n.props.onClick as () => void)();
const one = (tree: unknown, pred: (n: HostNode) => boolean): HostNode => {
  const f = find(tree, pred);
  expect(f).toHaveLength(1);
  return f[0]!;
};
const labelled = (label: string) => (n: HostNode): boolean => n.props["aria-label"] === label;

describe("the Mixer panel", () => {
  it("renders a strip per bus, in tree order", async () => {
    const r = await rig();
    expect(find(r.tree(), (n) => n.props.role === "group" && typeof n.props["data-bus"] === "string").map((n) => n.props["data-bus"])).toEqual(["master", "sfx", "music"]);
  });

  it("a button per snapshot, disabled outside Play, pressed for the one in force; a click picks it", async () => {
    const r = await rig();
    let buttons = find(r.tree(), byClass("mixer-snapshot"));
    expect(buttons.map(text)).toEqual(["Paused", "Menu"]);
    expect(buttons.every((b) => b.props.disabled === true)).toBe(true);
    r.play();
    buttons = find(r.tree(), byClass("mixer-snapshot"));
    expect(buttons.every((b) => b.props.disabled === false)).toBe(true);
    click(buttons[1]!);
    expect(r.log.snapshots).toEqual(["Menu"]);
    buttons = find(r.tree(), byClass("mixer-snapshot"));
    expect(buttons.map((b) => b.props["aria-pressed"])).toEqual([false, true]);
  });

  it("the target picker has an option per target, the one in force selected; changing it sets Audio.loudnessTarget", async () => {
    const r = await rig();
    const select = () => one(r.tree(), labelled("Loudness target"));
    const options = () => find(select(), (n) => n.type === "option");
    expect(options().map((o) => o.props.value)).toEqual(["console", "mobile", "broadcast"]);
    expect(options().map((o) => o.props.selected)).toEqual([true, false, false]);
    expect(text(options()[2])).toBe("broadcast (-23 LUFS ±1 LU, -2 dBTP)");
    (select().props.onChange as (e: unknown) => void)({ currentTarget: { value: "mobile" } });
    expect(r.log.targets).toEqual(["mobile"]);
    expect(options().map((o) => o.props.selected)).toEqual([false, true, false]);
    expect(editor.project.settings.canUndo()).toBe(false); // never a commit
  });

  it("Reset, Pause (with its pressed state and label) and the elapsed time", async () => {
    const r = await rig();
    r.play();
    r.advance(65);
    const tree = r.tree();
    expect(text(find(tree, byClass("mixer-elapsed"))[0])).toBe("1:05");
    click(find(tree, byClass("mixer-reset"))[0]!);
    expect(r.log.hub).toContain("reset:all");
    expect(text(find(r.tree(), byClass("mixer-elapsed"))[0])).toBe("0:00");
    let pause = find(r.tree(), byClass("mixer-pause"))[0]!;
    expect([text(pause), pause.props["aria-pressed"]]).toEqual(["Pause", false]);
    click(pause);
    expect(r.log.hub).toContain("pause");
    pause = find(r.tree(), byClass("mixer-pause"))[0]!;
    expect([text(pause), pause.props["aria-pressed"]]).toEqual(["Resume", true]);
    click(pause);
    expect(r.log.hub).toContain("resume");
    expect(text(find(r.tree(), byClass("mixer-pause"))[0])).toBe("Pause");
  });

  it("Compare: disabled outside Play, a toggle button in Play, pressed while on; off, the edited mix is back", async () => {
    const r = await rig();
    expect(find(r.tree(), byClass("mixer-compare"))[0]!.props.disabled).toBe(true);
    r.play();
    const opLog = startOpLog(() => mixer); // in Play, a committed edit reaches the play mixer through the op log
    cleanups.push(opLog.dispose);
    const key = one(r.tree(), labelled("sfx volume")).props.onKeyDown as (e: unknown) => void;
    key({ key: "Home", preventDefault() {} }); // the sfx fader to the bottom: one committed edit
    const edited = positionToGain(0);
    await vi.waitFor(() => expect(r.liveVolume("sfx")).toBe(edited));
    let b = find(r.tree(), byClass("mixer-compare"))[0]!;
    expect([b.props.disabled, b.props["aria-pressed"]]).toEqual([false, false]);
    click(b);
    b = find(r.tree(), byClass("mixer-compare"))[0]!;
    expect(b.props["aria-pressed"]).toBe(true);
    expect(r.liveVolume("sfx")).toBe(1); // the saved mix from Play start
    click(b);
    expect(find(r.tree(), byClass("mixer-compare"))[0]!.props["aria-pressed"]).toBe(false);
    expect(r.liveVolume("sfx")).toBe(edited);
    expect(r.log.marks).toEqual(["Compare: saved mix (Play start)", "Compare: edited mix"]);
    expect(r.log.hub.filter((x) => x.startsWith("compare:"))).toEqual(["compare:true", "compare:false"]);
  });

  it("every banner is rendered with its id, severity and text", async () => {
    const r = await rig({ ...AUDIO, buses: [{ name: "master" }, { name: "sfx", parent: "master", effects: [{ type: "nope" }] }, { name: "music", parent: "master", meter: "loudness" }] });
    r.play();
    r.log.entries.push({ seq: 1, cause: "edit", source: "recorded", ops: [], results: [{ ok: false, class: "direct", reason: "effectsPerBus" }], restartRequired: [] });
    click(one(r.tree(), labelled("Solo music")));
    click(find(r.tree(), byClass("mixer-compare"))[0]!);
    const banners = find(r.tree(), byClass("mixer-banner"));
    const byId = (id: string) => banners.filter((b) => b.props["data-banner"] === id);
    expect(byId("problem").length).toBeGreaterThan(0);
    expect(text(byId("restart")[0])).toBe(`Applies at the next Play: ${reasonMessage("effectsPerBus")}. The edit is saved.`);
    expect(text(byId("monitor")[0])).toBe(MIXER_BANNER_TEXT.monitor);
    expect(text(byId("compare")[0])).toBe(MIXER_BANNER_TEXT.compare);
    expect(byId("problem")[0]!.props["data-severity"]).toBe("warn");
    expect(byId("problem")[0]!.props.role).toBe("alert");
    expect(byId("restart")[0]!.props["data-severity"]).toBe("info");
    expect(byId("restart")[0]!.props.role).toBe("status");
  });

  it("shows the not-playing note outside Play and no banner list when there is nothing to say", async () => {
    const r = await rig();
    let tree = r.tree();
    expect(text(find(tree, byClass("mixer-empty"))[0])).toBe(NOT_PLAYING);
    expect(find(tree, byClass("mixer-banners"))).toEqual([]);
    r.play();
    tree = r.tree();
    expect(find(tree, byClass("mixer-empty"))).toEqual([]);
  });

  it("a strip's solo goes through the monitor and commits nothing", async () => {
    const r = await rig();
    r.play();
    click(one(r.tree(), labelled("Solo sfx")));
    expect(r.log.monitors).toEqual([["sfx", { solo: true }]]);
    expect(editor.project.settings.canUndo()).toBe(false);
  });
});
