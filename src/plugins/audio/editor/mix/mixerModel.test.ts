import { afterEach, describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import type { ApplyResult, MixOp } from "../../../../engine/audio/mixOps";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { createProjectSettingsSection } from "../../../../editor/projectSettingsSection";
import type { SettingsDraft } from "../../../../editor/projectSettingsModel";
import { onSectionChanged } from "../../../../editor/sectionChanged";
import { closeTestProject, openTestProject } from "../../../../editor/testing";
import { createOpLog, type MixApplier } from "./opLog";
import { buildStrips, createMixerModel, type BusReading, type MixerHost } from "./mixerModel";

const PROJECT = `{
  "name": "Game",
  "audio": { "buses": [{ "name": "master" }, { "name": "sfx", "parent": "master", "effects": [{ "type": "reverb", "send": 0.3 }] }, { "name": "music", "parent": "master", "volume": 0.8 }] }
}
`;

/** A mixer that holds the authored value it was last told, as the heard value. */
class HeardMixer implements MixApplier {
  heard = new Map<string, number>([["sfx", 1], ["music", 0.8]]);
  applied: MixOp[] = [];
  apply(op: MixOp): ApplyResult {
    this.applied.push(op);
    if (op.op === "setBus" && op.key === "volume") this.heard.set(op.bus, op.value as number);
    return { ok: true, class: "direct" };
  }
}

const unsubs: Array<() => void> = [];
afterEach(() => {
  while (unsubs.length) unsubs.pop()!();
  closeTestProject();
});

async function rig() {
  const { project } = await openTestProject({ "project.json": PROJECT });
  const section = createProjectSettingsSection().open(project);
  const mixer = new HeardMixer();
  const log = createOpLog({
    onSectionChanged: (k, l) => (unsubs.push(onSectionChanged(k, l)), unsubs[unsubs.length - 1]),
    isPlaying: () => true,
    mixer: () => mixer,
  });
  const flushes: number[] = [];
  const commits: string[] = [];
  const monitors: Array<[string, object]> = [];
  const host: MixerHost = {
    draft: () => section.draft,
    apply: (op) => mixer.apply(op),
    flushNow: () => void flushes.push(mixer.applied.length),
    commit: (label, next) => {
      commits.push(label);
      return section.edit(label, next);
    },
    setMonitor: (bus, c) => void monitors.push([bus, c]),
  };
  return { section, mixer, log, flushes, commits, monitors, model: createMixerModel(host) };
}

const sfxVolume = (d: SettingsDraft): number => (d.audio as { buses: Array<{ name: string; volume?: number }> }).buses.find((b) => b.name === "sfx")!.volume ?? 1;

describe("a fader drag", () => {
  it("50 moves are 50 previews, each flushed, and exactly one commit and one undo step on release", async () => {
    const { section, mixer, flushes, commits, log, model } = await rig();
    expect(model.beginDrag("sfx")).toBe(true);
    for (let i = 1; i <= 50; i++) model.drag(1 - i * 0.01);
    expect(mixer.applied).toHaveLength(50);
    expect(flushes).toHaveLength(50);
    expect(commits).toEqual([]);
    expect(section.canUndo).toBe(false); // previews never enter the history
    expect(log.entries).toEqual([]); // nor the op log
    expect(model.endDrag()).toBe(true);
    await Promise.resolve();
    expect(commits).toEqual(["Set sfx volume"]);
    expect(section.canUndo).toBe(true);
    expect(sfxVolume(section.draft)).toBeCloseTo(0.5, 10);
    // the heard value follows the drag to its last value
    expect(mixer.heard.get("sfx")).toBeCloseTo(0.5, 10);
    // the commit's recorded ops reached the op log as "recorded", not a diff
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ cause: "edit", source: "recorded" });
    // one undo step takes the whole drag back
    await section.undo();
    expect(sfxVolume(section.draft)).toBe(1);
    expect(section.canUndo).toBe(false);
    expect(mixer.heard.get("sfx")).toBe(1); // the heard value is restored
    await section.redo();
    expect(mixer.heard.get("sfx")).toBeCloseTo(0.5, 10);
  });

  it("a cancelled drag restores the start value and commits nothing", async () => {
    const { section, mixer, commits, log, model } = await rig();
    model.beginDrag("music");
    model.drag(0.1);
    model.drag(1.7);
    expect(mixer.heard.get("music")).toBe(1.7);
    model.cancelDrag();
    expect(mixer.heard.get("music")).toBe(0.8);
    expect(commits).toEqual([]);
    expect(section.canUndo).toBe(false);
    expect(log.entries).toEqual([]);
    expect(model.dragging).toBeNull();
    // the model is usable again
    expect(model.beginDrag("music")).toBe(true);
  });

  it("a cancel before any move sends nothing, and an endDrag with no move commits nothing", async () => {
    const { mixer, commits, model } = await rig();
    model.beginDrag("sfx");
    model.cancelDrag();
    model.beginDrag("sfx");
    expect(model.endDrag()).toBe(false);
    expect(mixer.applied).toEqual([]);
    expect(commits).toEqual([]);
  });

  it("a drag that comes back to its start commits nothing", async () => {
    const { commits, model } = await rig();
    model.beginDrag("sfx");
    model.drag(0.2);
    model.drag(1);
    expect(model.endDrag()).toBe(false);
    expect(commits).toEqual([]);
  });

  it("clamps to 0..2, ignores a non-finite value, refuses an unknown bus and a second drag", async () => {
    const { mixer, model } = await rig();
    expect(model.beginDrag("nope")).toBe(false);
    expect(model.beginDrag("sfx")).toBe(true);
    expect(model.beginDrag("music")).toBe(false);
    model.drag(9);
    model.drag(-3);
    model.drag(Number.NaN);
    expect(mixer.applied.map((o) => (o as { value: number }).value)).toEqual([2, 0]);
    expect(model.dragging).toEqual({ bus: "sfx", value: 0 });
  });

  it("drag and endDrag with no open drag do nothing", async () => {
    const { mixer, commits, model } = await rig();
    model.drag(0.5);
    expect(model.endDrag()).toBe(false);
    model.cancelDrag();
    expect(mixer.applied).toEqual([]);
    expect(commits).toEqual([]);
  });

  it("still commits when no play Engine answers the previews", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const section = createProjectSettingsSection().open(project);
    const model = createMixerModel({
      draft: () => section.draft,
      apply: () => ({ ok: false, class: "none", restartRequired: "no live audio backend" }),
      flushNow: () => {},
      commit: (l, n) => section.edit(l, n),
    });
    model.beginDrag("sfx");
    model.drag(0.4);
    expect(model.endDrag()).toBe(true);
    await Promise.resolve();
    expect(sfxVolume(section.draft)).toBe(0.4);
  });
});

describe("toggles and typed values", () => {
  it("a mute toggle is one commit and one undo step, and toggles back", async () => {
    const { section, mixer, commits, model } = await rig();
    expect(model.toggleMute("sfx")).toBe(true);
    await Promise.resolve();
    expect(commits).toEqual(["Mute sfx"]);
    expect(mixer.applied).toEqual([{ op: "setBus", bus: "sfx", key: "mute", value: true }]);
    expect(model.toggleMute("sfx")).toBe(true);
    await Promise.resolve();
    expect(commits).toEqual(["Mute sfx", "Unmute sfx"]);
    await section.undo();
    expect(section.undoLabel).toBe("Mute sfx");
    expect(model.toggleMute("nope")).toBe(false);
  });

  it("solo is a monitor control: never a commit, never a preview", async () => {
    const { section, mixer, commits, monitors, model } = await rig();
    model.toggleSolo("sfx", false);
    model.toggleSolo("sfx", true);
    expect(monitors).toEqual([["sfx", { solo: true }], ["sfx", { solo: false }]]);
    expect(commits).toEqual([]);
    expect(mixer.applied).toEqual([]);
    expect(section.canUndo).toBe(false);
  });

  it("a typed volume is one commit, clamped; the same value commits nothing", async () => {
    const { section, commits, model } = await rig();
    expect(model.setVolume("sfx", 5)).toBe(true);
    await Promise.resolve();
    expect(sfxVolume(section.draft)).toBe(2);
    expect(model.setVolume("sfx", 2)).toBe(false);
    expect(model.setVolume("sfx", Number.NaN)).toBe(false);
    expect(commits).toEqual(["Set sfx volume"]);
  });
});

describe("strips", () => {
  const settings = parseAudioSettings(JSON.parse(PROJECT).audio).settings;

  it("come in tree order with authored values, sends and depth", () => {
    const strips = buildStrips(settings);
    expect(strips.map((s) => [s.name, s.depth, s.parent])).toEqual([["master", 0, null], ["sfx", 1, "master"], ["music", 1, "master"]]);
    expect(strips[1]).toMatchObject({ volume: 1, mute: false, sends: [0.3], live: false, metered: false });
    expect(strips[0]).toMatchObject({ root: true, metered: true });
    expect(strips[2].volume).toBe(0.8);
  });

  it("show the drag's previewed value on its strip only", () => {
    const strips = buildStrips(settings, () => null, () => undefined, { bus: "sfx", value: 0.25 });
    expect(strips.map((s) => [s.dragging, s.shownVolume])).toEqual([[false, 1], [true, 0.25], [false, 0.8]]);
  });

  it("carry the live readings and the folded meter numbers", () => {
    const reading: BusReading = { runtimeVolume: 0.5, runtimeMute: true, solo: true, peak: 0.7, effectiveGain: 0.4, duckGain: 0.6, activeVoices: 3, loudness: buildStrips(settings)[0].loudness, monitorSolo: true };
    const strips = buildStrips(settings, (n) => (n === "sfx" ? reading : null), (n) => (n === "music" ? { peak: 0.1, hold: 0.9, clipLatched: true } : undefined));
    expect(strips[1]).toMatchObject({ live: true, runtimeVolume: 0.5, runtimeMute: true, solo: true, monitorSolo: true, monitorMute: false, effectiveGain: 0.4, duckGain: 0.6, activeVoices: 3, meter: { peak: 0.7, hold: 0.7, clipLatched: false } });
    expect(strips[2].meter).toEqual({ peak: 0.1, hold: 0.9, clipLatched: true });
    expect(strips[2].live).toBe(false);
  });

  it("reflect a script's live Bus change without marking the project dirty", async () => {
    const { project } = await openTestProject({ "project.json": PROJECT });
    const section = createProjectSettingsSection().open(project);
    const mixer = new Mixer(settings);
    const model = createMixerModel({ draft: () => section.draft, apply: (o) => mixer.apply(o), flushNow: () => {}, commit: (l, n) => section.edit(l, n) });
    const read = (name: string): BusReading => {
      const b = mixer.bus(name);
      return { runtimeVolume: b.volume, runtimeMute: b.mute, solo: b.solo, peak: b.peak, effectiveGain: b.effectiveGain, duckGain: b.duckGain, activeVoices: b.activeVoices, loudness: b.loudness };
    };
    expect(model.strips(read)[1].runtimeVolume).toBe(1);
    mixer.bus("sfx").volume = 0.5; // a script
    mixer.bus("sfx").mute = true;
    const sfx = model.strips(read)[1];
    expect(sfx).toMatchObject({ runtimeVolume: 0.5, runtimeMute: true, volume: 1, mute: false });
    expect(section.unsaved).toBe(false);
    expect(section.canUndo).toBe(false);
    expect(sfxVolume(section.draft)).toBe(1);
  });
});
