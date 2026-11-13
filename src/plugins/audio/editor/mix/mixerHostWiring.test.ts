// G8a: what the editor half hands the Mixer panel. `wireMixerHost` fills `mixerHost.flushNow` and `mixerHost.entries`; with the
// op log's entries behind it, the restart banner lists an op the op log recorded from a Project Settings section edit (not only
// the panel's own previews); a drag preview calls `flushNow`; the monitor mute never commits and names the bus the hub taints.
// No wall clock: the op log is synchronous and the clock is a counter.
import { afterEach, describe, expect, it } from "vitest";
import { createProjectSettingsSection } from "../../../../editor/projectSettingsSection";
import type { SettingsDraft } from "../../../../editor/projectSettingsModel";
import { onSectionChanged } from "../../../../editor/sectionChanged";
import { closeTestProject, openTestProject } from "../../../../editor/testing";
import { EMPTY_BUS_LOUDNESS } from "../../../../engine/audio/loudnessTypes";
import type { ApplyResult, MixOp } from "../../../../engine/audio/mixOps";
import { positionToGain } from "./faderModel";
import { wireMixerHost } from "./index";
import { mixerHost } from "./MixerPanel";
import { MixerPanelController, type MixerPanelDeps } from "./mixerPanelModel";
import { createOpLog, type OpLog, type OpLogEntry } from "./opLog";

const PROJECT = JSON.stringify({ name: "Game", audio: { buses: [{ name: "master" }, { name: "sfx", parent: "master" }, { name: "music", parent: "master" }] } });

const unsubs: Array<() => void> = [];
afterEach(() => {
  while (unsubs.length) unsubs.pop()!();
  closeTestProject();
  mixerHost.flushNow = null;
  mixerHost.entries = null;
});

const sfxVolume = (d: SettingsDraft, volume: number): SettingsDraft => {
  const audio = d.audio as { buses: Array<Record<string, unknown>> };
  return { ...d, audio: { ...audio, buses: audio.buses.map((b) => (b.name === "sfx" ? { ...b, volume } : b)) } } as SettingsDraft;
};

async function rig() {
  const { project } = await openTestProject({ "project.json": PROJECT });
  const section = createProjectSettingsSection().open(project);
  const applied: MixOp[] = [];
  // The play mixer: everything answers restartRequired, as an engine without a live path does.
  const answer = (op: MixOp): ApplyResult => (applied.push(op), { ok: false, class: "none", restartRequired: "no live audio backend" });
  const log: OpLog = createOpLog({
    onSectionChanged: (k, l) => (unsubs.push(onSectionChanged(k, l)), unsubs[unsubs.length - 1]),
    isPlaying: () => true,
    mixer: () => ({ apply: answer }),
  });
  let flushes = 0;
  const hub: string[] = [];
  const monitors: Array<[string, object]> = [];
  const commits: string[] = [];
  wireMixerHost(mixerHost, { flushNow: () => void flushes++, entries: () => log.entries });
  const deps: MixerPanelDeps = {
    draft: () => section.draft,
    commit: (label, next) => { commits.push(label); return section.edit(label, next); },
    playing: () => true,
    apply: (op) => (applied.push(op), { ok: true, class: "direct" }),
    flushNow: () => mixerHost.flushNow?.(),
    readBus: () => ({ runtimeVolume: 1, runtimeMute: false, solo: false, peak: 0, effectiveGain: 1, duckGain: 1, activeVoices: 0, loudness: EMPTY_BUS_LOUDNESS }),
    setMonitor: (bus, c) => void monitors.push([bus, c]),
    hub: {
      reset() {}, pause() {}, resume() {},
      noteMonitorMute: (b) => void hub.push(`mute:${b}`),
      noteMonitorSolo: () => void hub.push("solo"),
      setMonitorActive: (on) => void hub.push(`active:${on}`),
      setCompare() {},
    },
    target: () => null,
    setTarget() {},
    snapshot() {},
    currentSnapshot: () => null,
    mark() {},
    clock: () => 0,
    entries: () => mixerHost.entries?.() ?? [],
  };
  const c = new MixerPanelController(deps, () => {});
  c.sample();
  return { c, section, log, commits, monitors, hub, flushes: () => flushes };
}

describe("wireMixerHost", () => {
  it("entries reads the source's current list each call; flushNow reaches the source", () => {
    let list: OpLogEntry[] = [];
    let flushes = 0;
    wireMixerHost(mixerHost, { flushNow: () => void flushes++, entries: () => list });
    expect(mixerHost.entries!()).toEqual([]);
    list = [{ seq: 1, cause: "edit", source: "recorded", ops: [], results: [], restartRequired: ["x"] }];
    expect(mixerHost.entries!()).toBe(list);
    mixerHost.flushNow!();
    expect(flushes).toBe(1);
  });
});

describe("the Mixer panel over the host", () => {
  it("the restart banner lists an op the op log recorded from a Project Settings edit", async () => {
    const r = await rig();
    expect(r.c.view().banners.map((b) => b.id)).not.toContain("restart");
    await r.section.edit("Volume", sfxVolume(r.section.draft, 0.5)); // not the panel's own preview: the section's edit
    expect(r.log.entries.length).toBeGreaterThan(0);
    const banner = r.c.view().banners.find((b) => b.id === "restart");
    expect(banner?.text).toContain("no live audio backend");
  });

  it("a drag preview calls flushNow once per move, and commits one undo step on release only", async () => {
    const r = await rig();
    expect(r.c.stripModel.beginDrag("sfx")).toBe(true);
    r.c.stripModel.drag(positionToGain(0.4));
    r.c.stripModel.drag(positionToGain(0.5));
    expect(r.flushes()).toBe(2);
    expect(r.commits).toEqual([]);
    expect(r.section.canUndo).toBe(false);
    r.c.stripModel.endDrag();
    await Promise.resolve();
    expect(r.commits).toHaveLength(1);
    expect(r.section.canUndo).toBe(true);
  });

  it("the monitor mute never commits, names the bus the hub taints, and a second press releases it", async () => {
    const r = await rig();
    expect(r.c.stripModel.toggleMonitorMute!("music")).toBe(true);
    expect(r.monitors).toEqual([["music", { mute: true }]]);
    expect(r.hub).toEqual(["mute:music", "active:true"]);
    expect(r.commits).toEqual([]);
    expect(r.section.canUndo).toBe(false);
    expect(r.c.view().strips.find((s) => s.name === "music")!.monitorMute).toBe(true);
    expect(r.c.view().strips.find((s) => s.name === "sfx")!.monitorMute).toBe(false);
    expect(r.c.stripModel.toggleMonitorMute!("music")).toBe(true);
    expect(r.monitors[1]).toEqual(["music", { mute: false }]);
    expect(r.hub.at(-1)).toBe("active:false");
  });
});
