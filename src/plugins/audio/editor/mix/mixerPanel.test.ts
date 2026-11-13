// The Mixer panel (task Mp2b): the controller over injected deps, and the chrome rendered from its view. Cases: every banner on
// fixtures (a problem, applies at the next Play with the op's message, monitor active, Compare), the snapshot buttons, the target
// picker (an entry per target), Reset, Pause and the elapsed time (on a fake audio clock), Compare on and off restoring the edited
// mix with no commit and no undo step, a fader drag as one undo step through a real project section, and the strips following the
// 50 ms readings without marking the project dirty. No assertion reads a wall clock: the clock is the one the test advances.
import type { VNode } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import type { SettingsDraft } from "../../../../editor/sdk";
import { createProjectSettingsSection } from "../../../../editor/projectSettingsSection";
import { onSectionChanged } from "../../../../editor/sectionChanged";
import { closeTestProject, openTestProject } from "../../../../editor/testing";
import { EMPTY_BUS_LOUDNESS, type LoudnessResetWhat } from "../../../../engine/audio/loudnessTypes";
import { applyOpToSettings, type ApplyResult, type MixOp } from "../../../../engine/audio/mixOps";
import { parseAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { MixerChrome } from "./MixerPanel";
import type { BusReading } from "./mixerModel";
import {
  MIXER_BANNER_TEXT, MixerPanelController, NOT_PLAYING, formatElapsed, mixerBanners, restartMessages, type MixerPanelDeps, type MixerView,
} from "./mixerPanelModel";
import type { OpLogEntry } from "./opLog";
import { PEAK_HOLD_MS } from "./meterModel";

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
const PROJECT = JSON.stringify({ name: "Game", audio: AUDIO });

const reading = (over: Partial<BusReading> = {}): BusReading => ({ runtimeVolume: 1, runtimeMute: false, solo: false, peak: 0, effectiveGain: 1, duckGain: 1, activeVoices: 0, loudness: EMPTY_BUS_LOUDNESS, ...over });

/** Everything outside the panel, faked: a draft, a live mixer that applies the ops it is given, a hub, a clock. */
function rig(opts: { audio?: unknown; commit?: MixerPanelDeps["commit"]; draft?: () => SettingsDraft | null } = {}) {
  let draft: SettingsDraft = { audio: opts.audio ?? AUDIO } as SettingsDraft;
  let playing = false;
  let clock = 0;
  let snapshot: string | null = null;
  let target: string | null = null;
  let live: AudioSettings = parseAudioSettings(draft.audio).settings;
  const peaks = new Map<string, number>();
  const answers = new Map<string, ApplyResult>();
  const log = {
    applied: [] as MixOp[], flushes: 0, commits: [] as string[], monitors: [] as Array<[string, object]>, marks: [] as string[],
    hub: [] as string[], targets: [] as string[], snapshots: [] as Array<string | null>, entries: [] as OpLogEntry[],
  };
  const deps: MixerPanelDeps = {
    draft: opts.draft ?? (() => draft),
    // The default commit saves the draft and, as the op log does in Play, brings the live mix to it.
    commit: opts.commit ?? ((label, next) => { log.commits.push(label); draft = next; live = parseAudioSettings(next.audio).settings; }),
    playing: () => playing,
    apply: (op) => {
      log.applied.push(op);
      live = applyOpToSettings(live, op);
      return answers.get(op.op) ?? { ok: true, class: "direct" };
    },
    flushNow: () => void log.flushes++,
    readBus: (name) => (live.buses.some((b) => b.name === name) ? reading({ peak: peaks.get(name) ?? 0 }) : null),
    setMonitor: (bus, c) => void log.monitors.push([bus, c]),
    hub: {
      reset: (what: LoudnessResetWhat) => void log.hub.push(`reset:${what}`),
      pause: () => void log.hub.push("pause"),
      resume: () => void log.hub.push("resume"),
      noteMonitorMute: (b) => void log.hub.push(`mute:${b}`),
      noteMonitorSolo: () => void log.hub.push("solo"),
      setMonitorActive: (on) => void log.hub.push(`active:${on}`),
      setCompare: (on) => void log.hub.push(`compare:${on}`),
    },
    target: () => target,
    setTarget: (n) => { target = n; log.targets.push(n); },
    snapshot: (n) => { snapshot = n; log.snapshots.push(n); },
    currentSnapshot: () => snapshot,
    mark: (t) => void log.marks.push(t),
    clock: () => clock,
    entries: () => log.entries,
  };
  let changes = 0;
  const c = new MixerPanelController(deps, () => void changes++);
  return {
    c, log, deps,
    changes: () => changes,
    draft: () => draft,
    setDraft: (d: SettingsDraft) => { draft = d; },
    live: () => live,
    play: (on = true) => { playing = on; c.sample(); },
    advance: (s: number) => { clock += s; },
    peak: (bus: string, v: number) => void peaks.set(bus, v),
    answer: (op: MixOp["op"], r: ApplyResult) => void answers.set(op, r),
    setTargetOutside: (n: string | null) => { target = n; },
    setSnapshotOutside: (n: string | null) => { snapshot = n; },
    volume: (bus: string): number => parseAudioSettings(draft.audio).settings.buses.find((b) => b.name === bus)!.volume,
    liveVolume: (bus: string): number => live.buses.find((b) => b.name === bus)!.volume,
  };
}

const bannerIds = (v: MixerView): string[] => v.banners.map((b) => b.id);

afterEach(() => closeTestProject());

// ---- banners ----

describe("the banners (pure)", () => {
  it("each banner has its text, severity and place: problems, then applies-at-next-Play, then monitor, then Compare", () => {
    const all = mixerBanners({ monitorActive: true, compareActive: true, restart: ["voices"], problems: ["audio.buses must be a list."] });
    expect(all.map((b) => b.id)).toEqual(["problem", "restart", "monitor", "compare"]);
    expect(all.map((b) => b.text)).toEqual(["audio.buses must be a list.", "Applies at the next Play: voices. The edit is saved.", MIXER_BANNER_TEXT.monitor, MIXER_BANNER_TEXT.compare]);
    expect(all.map((b) => b.severity)).toEqual(["warn", "info", "info", "warn"]);
  });

  it("nothing to say, no banner; several problems and several restart messages each get one", () => {
    expect(mixerBanners({ monitorActive: false, compareActive: false, restart: [], problems: [] })).toEqual([]);
    const two = mixerBanners({ monitorActive: false, compareActive: false, restart: ["a", "b"], problems: ["x", "y"] });
    expect(two.map((b) => b.id)).toEqual(["problem", "problem", "restart", "restart"]);
  });

  it("restartMessages: each message once, from the results and the diff's keys, only for entries after the baseline", () => {
    const entry = (seq: number, results: ApplyResult[], restartRequired: string[] = []): OpLogEntry => ({ seq, cause: "edit", source: "recorded", ops: [], results, restartRequired });
    const entries = [
      entry(1, [{ ok: false, class: "none", restartRequired: "old" }]),
      entry(2, [{ ok: false, class: "none", restartRequired: "voices" }, { ok: true, class: "direct" }]),
      entry(3, [{ ok: false, class: "none", restartRequired: "voices" }], ["backend"]),
    ];
    expect(restartMessages(entries, 1)).toEqual(["voices", "backend"]);
    expect(restartMessages(entries, 0)).toEqual(["old", "voices", "backend"]);
    expect(restartMessages(entries, 3, ["mine"])).toEqual(["mine"]);
  });

  it("formatElapsed: m:ss, then h:mm:ss; bad input reads 0:00", () => {
    expect([0, 59.9, 60, 3599, 3600, 3725, -5, NaN].map(formatElapsed)).toEqual(["0:00", "0:59", "1:00", "59:59", "1:00:00", "1:02:05", "0:00", "0:00"]);
  });
});

describe("every banner on fixtures, through the controller", () => {
  it("a problem in the audio section: one banner per problem, in and out of Play", () => {
    const r = rig({ audio: { buses: [{ name: "master" }, { name: "sfx", parent: "master", effects: [{ type: "nope" }] }] } });
    const problems = parseAudioSettings(r.draft().audio).problems;
    expect(problems.length).toBeGreaterThan(0);
    r.c.sample();
    const v = r.c.view();
    expect(v.banners.filter((b) => b.id === "problem").map((b) => b.text)).toEqual(problems);
    r.play();
    expect(r.c.view().banners.filter((b) => b.id === "problem")).toHaveLength(problems.length);
  });

  it("a clean section has no problem banner", () => {
    const r = rig();
    r.play();
    expect(bannerIds(r.c.view())).toEqual([]);
  });

  it("applies at the next Play: the op's message from the op log, from the diff's keys, and from a preview the mixer refused", () => {
    const r = rig();
    r.play();
    expect(bannerIds(r.c.view())).toEqual([]);
    r.log.entries.push({ seq: 1, cause: "edit", source: "recorded", ops: [], results: [{ ok: false, class: "none", restartRequired: "voice limits" }], restartRequired: [] });
    r.log.entries.push({ seq: 2, cause: "undo", source: "diff", ops: [], results: [], restartRequired: ["backend"] });
    const v = r.c.view();
    expect(v.banners.filter((b) => b.id === "restart").map((b) => b.text)).toEqual([
      "Applies at the next Play: voice limits. The edit is saved.",
      "Applies at the next Play: backend. The edit is saved.",
    ]);
    // A fader preview the mixer can't serve live (no live backend) says the same.
    r.answer("setBus", { ok: false, class: "none", restartRequired: "no live audio backend" });
    expect(r.c.stripModel.beginDrag("sfx")).toBe(true);
    r.c.stripModel.drag(0.4);
    r.c.stripModel.cancelDrag();
    expect(r.c.view().banners.map((b) => b.text)).toContain("Applies at the next Play: no live audio backend. The edit is saved.");
  });

  it("entries from before this Play don't show; Stop clears the banner", () => {
    const r = rig();
    r.log.entries.push({ seq: 4, cause: "edit", source: "recorded", ops: [], results: [{ ok: false, class: "none", restartRequired: "earlier" }], restartRequired: [] });
    r.play();
    expect(bannerIds(r.c.view())).toEqual([]);
    r.log.entries.push({ seq: 5, cause: "edit", source: "recorded", ops: [], results: [{ ok: false, class: "none", restartRequired: "later" }], restartRequired: [] });
    expect(bannerIds(r.c.view())).toEqual(["restart"]);
    r.play(false);
    expect(bannerIds(r.c.view())).toEqual([]);
  });

  it("monitor active: a solo shows it, switching it off clears it; outside Play the solo button does nothing", () => {
    const r = rig();
    r.c.stripModel.toggleSolo("sfx", false);
    expect(r.log.monitors).toEqual([]);
    r.play();
    r.c.stripModel.toggleSolo("sfx", false);
    expect(r.log.monitors).toEqual([["sfx", { solo: true }]]);
    const v = r.c.view();
    expect(bannerIds(v)).toEqual(["monitor"]);
    expect(v.banners[0]!.text).toBe(MIXER_BANNER_TEXT.monitor);
    expect(v.monitorActive).toBe(true);
    expect(v.strips.find((s) => s.name === "sfx")!.monitorSolo).toBe(true);
    expect(v.strips.find((s) => s.name === "music")!.monitorSolo).toBe(false);
    r.c.stripModel.toggleSolo("sfx", true);
    expect(bannerIds(r.c.view())).toEqual([]);
    expect(r.log.hub).toContain("active:true");
    expect(r.log.hub).toContain("active:false");
  });

  it("monitor active by a monitor mute", () => {
    const r = rig();
    expect(r.c.toggleMonitorMute("music")).toBe(false);
    r.play();
    expect(r.c.toggleMonitorMute("music")).toBe(true);
    expect(r.log.monitors).toEqual([["music", { mute: true }]]);
    expect(bannerIds(r.c.view())).toEqual(["monitor"]);
    expect(r.c.view().strips.find((s) => s.name === "music")!.monitorMute).toBe(true);
  });

  it("Compare: the banner while it is on, gone when it is off", () => {
    const r = rig();
    r.play();
    r.c.stripModel.setVolume("sfx", 0.4);
    r.c.toggleCompare();
    const v = r.c.view();
    expect(bannerIds(v)).toEqual(["compare"]);
    expect(v.banners[0]!.text).toBe(MIXER_BANNER_TEXT.compare);
    r.c.toggleCompare();
    expect(bannerIds(r.c.view())).toEqual([]);
  });

  it("all four at once", () => {
    const r = rig({ audio: { ...AUDIO, buses: [{ name: "master" }, { name: "sfx", parent: "master", effects: [{ type: "nope" }] }, { name: "music", parent: "master", meter: "loudness" }] } });
    r.play();
    r.log.entries.push({ seq: 1, cause: "edit", source: "recorded", ops: [], results: [{ ok: false, class: "none", restartRequired: "voice limits" }], restartRequired: [] });
    r.c.stripModel.toggleSolo("music", false);
    r.c.toggleCompare();
    expect([...new Set(bannerIds(r.c.view()))]).toEqual(["problem", "restart", "monitor", "compare"]);
  });
});

// ---- snapshots, target, reset, pause, elapsed ----

describe("snapshot buttons", () => {
  it("one button per snapshot, none in force at first, all inert outside Play", () => {
    const r = rig();
    expect(r.c.view().snapshots).toEqual([{ name: "Paused", active: false }, { name: "Menu", active: false }]);
    r.c.pickSnapshot("Paused");
    expect(r.log.snapshots).toEqual([]);
  });

  it("a click fades to that snapshot; the one in force is marked; one at a time", () => {
    const r = rig();
    r.play();
    r.c.pickSnapshot("Paused");
    expect(r.log.snapshots).toEqual(["Paused"]);
    expect(r.c.view().snapshots).toEqual([{ name: "Paused", active: true }, { name: "Menu", active: false }]);
    r.c.pickSnapshot("Menu");
    expect(r.log.snapshots).toEqual(["Paused", "Menu"]);
    expect(r.c.view().snapshots).toEqual([{ name: "Paused", active: false }, { name: "Menu", active: true }]);
  });

  it("a click on the one in force fades back to the plain mix; an unknown name does nothing; a script's snapshot shows", () => {
    const r = rig();
    r.play();
    r.setSnapshotOutside("Menu");
    expect(r.c.view().snapshots.find((s) => s.name === "Menu")!.active).toBe(true);
    r.c.pickSnapshot("Menu");
    expect(r.log.snapshots).toEqual([null]);
    r.c.pickSnapshot("Nope");
    expect(r.log.snapshots).toEqual([null]);
  });

  it("a project with no snapshots has none", () => {
    const r = rig({ audio: { buses: [{ name: "master" }] } });
    expect(r.c.view().snapshots).toEqual([]);
  });
});

describe("the target picker", () => {
  it("lists the project's targets with the one in force marked (the first until a pick)", () => {
    const r = rig();
    const t = r.c.view().targets;
    expect(t.map((x) => x.name)).toEqual(["console", "mobile", "broadcast"]);
    expect(t.map((x) => x.selected)).toEqual([true, false, false]);
    expect(t.map((x) => x.label)).toEqual(["-24 LUFS ±2 LU, -1 dBTP", "-18 LUFS ±2 LU, -1 dBTP", "-23 LUFS ±1 LU, -2 dBTP"]);
  });

  it.each(["console", "mobile", "broadcast"])("picking %s sets Audio.loudnessTarget and never commits", (name) => {
    const r = rig();
    expect(r.c.pickTarget(name)).toBe(true);
    expect(r.log.targets).toEqual([name]);
    expect(r.c.view().targets.find((x) => x.selected)!.name).toBe(name);
    expect(r.log.commits).toEqual([]);
  });

  it("an unknown name does nothing; a project with no table lists the two defaults", () => {
    const r = rig();
    expect(r.c.pickTarget("nope")).toBe(false);
    expect(r.log.targets).toEqual([]);
    const d = rig({ audio: { buses: [{ name: "master" }] } });
    expect(d.c.view().targets.map((x) => x.name)).toEqual(["console", "mobile"]);
  });

  it("follows a script's Audio.loudnessTarget at the next sample", () => {
    const r = rig();
    r.setTargetOutside("mobile");
    r.c.sample();
    expect(r.c.view().targets.find((x) => x.selected)!.name).toBe("mobile");
    r.setTargetOutside(null);
    r.c.sample();
    expect(r.c.view().targets.find((x) => x.selected)!.name).toBe("console");
  });
});

describe("Reset, Pause and the elapsed time (the audio clock)", () => {
  it("elapsed counts audio seconds since the last reset", () => {
    const r = rig();
    r.play();
    r.advance(75);
    expect(r.c.view().elapsed).toBe("1:15");
    r.c.reset("all");
    expect(r.log.hub).toContain("reset:all");
    expect(r.c.view().elapsed).toBe("0:00");
    r.advance(5);
    expect(r.c.view().elapsed).toBe("0:05");
  });

  it("Pause stops the elapsed time and calls the hub; Resume goes on", () => {
    const r = rig();
    r.play();
    r.advance(10);
    r.c.togglePause();
    expect(r.c.view().paused).toBe(true);
    r.advance(30);
    expect(r.c.view().elapsed).toBe("0:10");
    r.c.togglePause();
    expect(r.c.view().paused).toBe(false);
    r.advance(2);
    expect(r.c.view().elapsed).toBe("0:12");
    expect(r.log.hub.filter((h) => h === "pause" || h === "resume")).toEqual(["pause", "resume"]);
  });

  it("Reset clears the clip latches and the monitor's taint marks", () => {
    const r = rig();
    r.play();
    r.peak("sfx", 1.2);
    r.c.sample();
    expect(r.c.view().strips.find((s) => s.name === "sfx")!.meter.clipLatched).toBe(true);
    r.c.reset("all");
    expect(r.c.view().strips.find((s) => s.name === "sfx")!.meter.clipLatched).toBe(false);
    r.c.stripModel.toggleSolo("sfx", false);
    expect(r.c.monitor.taintedMeters().length).toBeGreaterThan(0);
    r.c.reset("all");
    expect(r.c.monitor.taintedMeters()).toEqual([]);
  });

  it("every gesture re-renders once through onChange", () => {
    const r = rig();
    r.play();
    const before = r.changes();
    r.c.reset("all");
    r.c.togglePause();
    r.c.pickTarget("mobile");
    r.c.pickSnapshot("Paused");
    r.c.toggleCompare();
    expect(r.changes() - before).toBe(5);
  });
});

// ---- Compare ----

describe("Compare", () => {
  it("is unavailable outside Play; on, it plays the saved mix; off, the edited mix is back; nothing is committed", () => {
    const r = rig();
    expect(r.c.toggleCompare()).toBeNull();
    expect(r.c.view().compare).toEqual({ available: false, active: false, differs: false });
    r.play();
    r.c.stripModel.setVolume("sfx", 0.4); // edited after Play started
    r.c.stripModel.setVolume("music", 1.5);
    const commits = [...r.log.commits];
    expect(commits).toHaveLength(2);
    expect(r.c.view().compare).toEqual({ available: true, active: false, differs: true });
    const edited = r.live();
    const on = r.c.toggleCompare()!;
    expect(on.active).toBe(true);
    expect(on.ops.length).toBe(2);
    expect(r.liveVolume("sfx")).toBe(1);
    expect(r.liveVolume("music")).toBe(0.8);
    const off = r.c.toggleCompare()!;
    expect(off.active).toBe(false);
    expect(r.live()).toEqual(edited);
    expect(r.volume("sfx")).toBe(0.4);
    expect(r.log.commits).toEqual(commits); // no commit
  });

  it("drops one capture marker and one flush per switch, and tells the hub", () => {
    const r = rig();
    r.play();
    r.c.stripModel.setVolume("sfx", 0.4);
    const flushes = r.log.flushes;
    r.c.toggleCompare();
    r.c.toggleCompare();
    expect(r.log.marks).toEqual(["Compare: saved mix (Play start)", "Compare: edited mix"]);
    expect(r.log.flushes - flushes).toBe(2);
    expect(r.log.hub.filter((h) => h.startsWith("compare:"))).toEqual(["compare:true", "compare:false"]);
  });

  it("locks the faders and the mute while on, and unlocks after", () => {
    const r = rig();
    r.play();
    r.c.stripModel.setVolume("sfx", 0.4);
    r.c.toggleCompare();
    const commits = r.log.commits.length;
    expect(r.c.stripModel.beginDrag("sfx")).toBe(false);
    expect(r.c.stripModel.setVolume("sfx", 0.9)).toBe(false);
    expect(r.c.stripModel.toggleMute("sfx")).toBe(false);
    expect(r.log.commits).toHaveLength(commits);
    r.c.toggleCompare();
    expect(r.c.stripModel.setVolume("sfx", 0.9)).toBe(true);
  });

  it("is a diff of the mix, so an unchanged mix swaps nothing", () => {
    const r = rig();
    r.play();
    expect(r.c.view().compare.differs).toBe(false);
    const swap = r.c.toggleCompare()!;
    expect(swap.ops).toEqual([]);
    r.c.toggleCompare();
  });

  it("ends with Stop, and a new Play starts from the then-edited mix", () => {
    const r = rig();
    r.play();
    r.c.stripModel.setVolume("sfx", 0.4);
    r.c.toggleCompare();
    r.play(false);
    expect(r.c.compare.active).toBe(false);
    expect(r.c.view().compare.available).toBe(false);
    r.play();
    expect(r.c.view().compare).toEqual({ available: true, active: false, differs: false });
  });

  it("Compare and the undo history: a real section keeps its one step and fires no section change", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const section = createProjectSettingsSection().open(project);
    const changes: string[] = [];
    const off = onSectionChanged("audio", (c) => void changes.push(c.cause));
    try {
      const r = rig({ draft: () => section.draft, commit: (label, next) => section.edit(label, next) });
      r.play();
      r.c.stripModel.setVolume("sfx", 0.4);
      await Promise.resolve();
      expect(changes).toEqual(["edit"]);
      const label = section.undoLabel;
      expect(label).toBe("Set sfx volume");
      r.c.toggleCompare();
      r.c.toggleCompare();
      expect(changes).toEqual(["edit"]);
      expect(section.undoLabel).toBe(label);
      expect(section.canRedo).toBe(false);
    } finally {
      off();
    }
  });
});

// ---- the fader: one undo step through the panel ----

describe("a fader drag", () => {
  it("is one undo step: many previews, one commit, one undo back to the start", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const section = createProjectSettingsSection().open(project);
    const r = rig({ draft: () => section.draft, commit: (label, next) => (r0.commits.push(label), section.edit(label, next)) });
    const r0 = { commits: [] as string[] };
    r.play();
    expect(section.canUndo).toBe(false);
    const m = r.c.stripModel;
    expect(m.beginDrag("sfx")).toBe(true);
    for (const v of [0.9, 0.8, 0.7, 0.6, 0.5]) m.drag(v);
    expect(r.log.applied).toHaveLength(5); // five previews through apply
    expect(r0.commits).toEqual([]); // none committed while it moves
    expect(section.canUndo).toBe(false);
    expect(m.endDrag()).toBe(true);
    await Promise.resolve();
    expect(r0.commits).toEqual(["Set sfx volume"]);
    expect(section.undoLabel).toBe("Set sfx volume");
    expect((section.draft.audio as { buses: Array<{ name: string; volume?: number }> }).buses.find((b) => b.name === "sfx")!.volume).toBe(0.5);
    await section.undo();
    expect(section.canUndo).toBe(false); // one step
    expect((section.draft.audio as { buses: Array<{ name: string; volume?: number }> }).buses.find((b) => b.name === "sfx")!.volume).toBeUndefined();
  });
});

// ---- sampling ----

describe("the strips follow the readings", () => {
  it("each sample folds the peaks; the draft is never written (the project stays clean)", () => {
    const r = rig();
    r.play();
    const draft = r.draft();
    for (const [t, p] of [[0.05, 0.1], [0.05, 0.4], [0.05, 0.2], [0.05, 0.05]] as const) {
      r.advance(t);
      r.peak("sfx", p);
      r.c.sample();
      const s = r.c.view().strips.find((x) => x.name === "sfx")!;
      expect(s.meter.peak).toBe(p);
    }
    expect(r.c.view().strips.find((x) => x.name === "sfx")!.meter.hold).toBe(0.4); // the hold keeps the loudest, within PEAK_HOLD_MS
    expect(r.draft()).toBe(draft);
    expect(r.log.commits).toEqual([]);
    expect(r.log.applied).toEqual([]);
    expect(r.c.samples).toBeGreaterThan(4);
  });

  it("the hold falls after PEAK_HOLD_MS of audio time; the clip latch stays until a click on it", () => {
    const r = rig();
    r.play();
    r.advance(1);
    r.peak("sfx", 1.1);
    r.c.sample();
    r.peak("sfx", 0.1);
    r.advance((PEAK_HOLD_MS * 4) / 1000);
    r.c.sample();
    const s = r.c.view().strips.find((x) => x.name === "sfx")!;
    expect(s.meter.hold).toBeLessThan(1.1);
    expect(s.meter.clipLatched).toBe(true);
    r.c.resetClip("sfx");
    expect(r.c.view().strips.find((x) => x.name === "sfx")!.meter.clipLatched).toBe(false);
  });

  it("outside Play the strips are at rest: no readings, no hold", () => {
    const r = rig();
    r.peak("sfx", 0.9);
    r.c.sample();
    const v = r.c.view();
    expect(v.playing).toBe(false);
    expect(v.empty).toBe(NOT_PLAYING);
    expect(v.strips.every((s) => !s.live && s.meter.peak === 0)).toBe(true);
    r.play();
    expect(r.c.view().empty).toBeNull();
    expect(r.c.view().strips.every((s) => s.live)).toBe(true);
  });

  it("a script's volume shows in the strip without a commit", () => {
    const r = rig();
    r.play();
    const readBus = r.deps.readBus;
    r.deps.readBus = (n) => (n === "sfx" ? { ...readBus(n)!, runtimeVolume: 0.25, effectiveGain: 0.25 } : readBus(n));
    const s = r.c.view().strips.find((x) => x.name === "sfx")!;
    expect(s.runtimeVolume).toBe(0.25);
    expect(s.effectiveGain).toBe(0.25);
    expect(s.volume).toBe(1);
    expect(r.log.commits).toEqual([]);
  });

  it("Stop and Play again start the meters over; loudnessResetOnPlay decides whether the elapsed time starts over too", () => {
    for (const [reset, elapsed] of [[true, "0:00"], [false, "0:30"]] as const) {
      const r = rig({ audio: { ...AUDIO, loudnessResetOnPlay: reset } });
      r.play();
      r.advance(30);
      r.peak("sfx", 1.5);
      r.c.sample();
      expect(r.c.view().strips.find((s) => s.name === "sfx")!.meter.clipLatched).toBe(true);
      r.play(false);
      r.peak("sfx", 0);
      r.play();
      expect(r.c.view().strips.find((s) => s.name === "sfx")!.meter.clipLatched).toBe(false);
      expect(r.c.view().elapsed).toBe(elapsed);
    }
  });

  it("level-ducked buses are named for the strips' gain-reduction meter", () => {
    const r = rig();
    expect([...r.c.view().ducked]).toEqual(["music"]);
  });

  it("Stop clears the monitor controls", () => {
    const r = rig();
    r.play();
    r.c.stripModel.toggleSolo("sfx", false);
    r.play(false);
    expect(r.c.monitor.active).toBe(false);
    expect(r.log.monitors).toContainEqual(["sfx", { solo: false }]);
  });
});

// ---- the chrome ----

type Node = VNode<Record<string, unknown>>;
function find(node: unknown, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (Array.isArray(node)) { node.forEach((c) => find(c, pred, out)); return out; }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const v = node as Node;
  if (typeof v.type === "function") return find((v.type as (p: unknown) => unknown)(v.props), pred, out);
  if (pred(v)) out.push(v);
  return find(v.props.children, pred, out);
}
function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  const v = node as Node;
  if (typeof v.type === "function") return text((v.type as (p: unknown) => unknown)(v.props));
  return text(v.props.children);
}
const byClass = (cls: string) => (n: Node): boolean => typeof n.props.class === "string" && n.props.class.split(" ").includes(cls);
const chrome = (r: ReturnType<typeof rig>, onChange = () => {}): VNode => MixerChrome({ controller: r.c, view: r.c.view(), onChange }) as VNode;
const click = (n: Node): void => (n.props.onClick as () => void)();

describe("the chrome", () => {
  it("renders a strip per bus, in tree order, on the controller's strip model", () => {
    const r = rig();
    const tree = chrome(r);
    expect(find(tree, (n) => n.props.role === "group" && typeof n.props["data-bus"] === "string").map((n) => n.props["data-bus"])).toEqual(["master", "sfx", "music"]);
  });

  it("a button per snapshot, disabled outside Play, pressed for the one in force; a click picks it", () => {
    const r = rig();
    let buttons = find(chrome(r), byClass("mixer-snapshot"));
    expect(buttons.map(text)).toEqual(["Paused", "Menu"]);
    expect(buttons.every((b) => b.props.disabled === true)).toBe(true);
    r.play();
    buttons = find(chrome(r), byClass("mixer-snapshot"));
    expect(buttons.every((b) => b.props.disabled === false)).toBe(true);
    click(buttons[1]!);
    expect(r.log.snapshots).toEqual(["Menu"]);
    buttons = find(chrome(r), byClass("mixer-snapshot"));
    expect(buttons.map((b) => b.props["aria-pressed"])).toEqual([false, true]);
  });

  it("the target picker has an option per target, the one in force selected; changing it picks", () => {
    const r = rig();
    const select = find(chrome(r), (n) => n.props["aria-label"] === "Loudness target")[0]!;
    const options = find(select, (n) => n.type === "option");
    expect(options.map((o) => o.props.value)).toEqual(["console", "mobile", "broadcast"]);
    expect(options.map((o) => o.props.selected)).toEqual([true, false, false]);
    expect(text(options[2])).toBe("broadcast (-23 LUFS ±1 LU, -2 dBTP)");
    let changed = 0;
    (find(chrome(r, () => void changed++), (n) => n.props["aria-label"] === "Loudness target")[0]!.props.onChange as (e: unknown) => void)({ currentTarget: { value: "mobile" } });
    expect(r.log.targets).toEqual(["mobile"]);
    expect(changed).toBe(1);
  });

  it("Reset, Pause (with its pressed state and label) and the elapsed time", () => {
    const r = rig();
    r.play();
    r.advance(65);
    const tree = chrome(r);
    expect(text(find(tree, byClass("mixer-elapsed"))[0])).toBe("1:05");
    click(find(tree, byClass("mixer-reset"))[0]!);
    expect(r.log.hub).toContain("reset:all");
    let pause = find(chrome(r), byClass("mixer-pause"))[0]!;
    expect([text(pause), pause.props["aria-pressed"]]).toEqual(["Pause", false]);
    click(pause);
    pause = find(chrome(r), byClass("mixer-pause"))[0]!;
    expect([text(pause), pause.props["aria-pressed"]]).toEqual(["Resume", true]);
    click(pause);
    expect(text(find(chrome(r), byClass("mixer-pause"))[0])).toBe("Pause");
  });

  it("Compare: disabled outside Play, a toggle button in Play, pressed while on", () => {
    const r = rig();
    expect(find(chrome(r), byClass("mixer-compare"))[0]!.props.disabled).toBe(true);
    r.play();
    r.c.stripModel.setVolume("sfx", 0.4);
    let b = find(chrome(r), byClass("mixer-compare"))[0]!;
    expect([b.props.disabled, b.props["aria-pressed"]]).toEqual([false, false]);
    click(b);
    b = find(chrome(r), byClass("mixer-compare"))[0]!;
    expect(b.props["aria-pressed"]).toBe(true);
    click(b);
    expect(find(chrome(r), byClass("mixer-compare"))[0]!.props["aria-pressed"]).toBe(false);
    expect(r.liveVolume("sfx")).toBe(0.4);
  });

  it("every banner is rendered with its id, severity and text", () => {
    const r = rig({ audio: { ...AUDIO, buses: [{ name: "master" }, { name: "sfx", parent: "master", effects: [{ type: "nope" }] }, { name: "music", parent: "master", meter: "loudness" }] } });
    r.play();
    r.log.entries.push({ seq: 1, cause: "edit", source: "recorded", ops: [], results: [{ ok: false, class: "none", restartRequired: "voice limits" }], restartRequired: [] });
    r.c.stripModel.toggleSolo("music", false);
    r.c.toggleCompare();
    const banners = find(chrome(r), byClass("mixer-banner"));
    const byId = (id: string) => banners.filter((b) => b.props["data-banner"] === id);
    expect(byId("problem").length).toBeGreaterThan(0);
    expect(text(byId("restart")[0])).toBe("Applies at the next Play: voice limits. The edit is saved.");
    expect(text(byId("monitor")[0])).toBe(MIXER_BANNER_TEXT.monitor);
    expect(text(byId("compare")[0])).toBe(MIXER_BANNER_TEXT.compare);
    expect(byId("problem")[0]!.props["data-severity"]).toBe("warn");
    expect(byId("problem")[0]!.props.role).toBe("alert");
    expect(byId("restart")[0]!.props["data-severity"]).toBe("info");
    expect(byId("restart")[0]!.props.role).toBe("status");
  });

  it("shows the not-playing note outside Play and no banner list when there is nothing to say", () => {
    const r = rig();
    let tree = chrome(r);
    expect(text(find(tree, byClass("mixer-empty"))[0])).toBe(NOT_PLAYING);
    expect(find(tree, byClass("mixer-banners"))).toEqual([]);
    r.play();
    tree = chrome(r);
    expect(find(tree, byClass("mixer-empty"))).toEqual([]);
  });

  it("a strip's solo goes through the monitor, and its fader is locked in Compare", () => {
    const r = rig();
    r.play();
    const solo = find(chrome(r), (n) => n.props["aria-label"] === "Solo sfx")[0]!;
    click(solo);
    expect(r.log.monitors).toEqual([["sfx", { solo: true }]]);
    expect(r.log.commits).toEqual([]);
  });
});
