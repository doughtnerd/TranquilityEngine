import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { createMonitorModel, type MonitorBus, type MonitorHost } from "./monitorModel";

// master > { sfx > { ui, hit }, music > { calm } }, plus an unmetered "amb" under master.
const BUSES: MonitorBus[] = [
  { name: "master" },
  { name: "sfx", parent: "master" },
  { name: "ui", parent: "sfx" },
  { name: "hit", parent: "sfx" },
  { name: "music", parent: "master" },
  { name: "calm", parent: "music" },
  { name: "amb", parent: "master" },
];
const ALL = BUSES.map((b) => b.name);
const METERED = ALL.filter((n) => n !== "amb");

function setup() {
  const calls: string[] = [];
  const host: MonitorHost = {
    setMonitor: (bus, c) => calls.push(`setMonitor ${bus} ${JSON.stringify(c)}`),
    noteMonitorMute: (bus) => calls.push(`noteMonitorMute ${bus}`),
    noteMonitorSolo: () => calls.push("noteMonitorSolo"),
    setMonitorActive: (on) => calls.push(`setMonitorActive ${on}`),
  };
  const model = createMonitorModel({ host, metered: METERED });
  model.setBuses(BUSES, METERED);
  return { model, calls };
}
const audibleSet = (m: ReturnType<typeof setup>["model"]) => ALL.filter((n) => m.audible(n)).sort();

// The §6.6 / ADR 0172 rules, one row each. `run` performs the gesture(s); `tainted` is the exact set of tainted meters.
interface Row {
  readonly rule: string;
  readonly run: (m: ReturnType<typeof setup>["model"]) => void;
  readonly tainted: string[];
  readonly calls: string[];
}
const SPEC: Row[] = [
  {
    rule: "a monitor mute of X taints X, its ancestors and master (leaf)",
    run: (m) => m.setMute("ui", true),
    tainted: ["master", "sfx", "ui"],
    calls: ['setMonitor ui {"mute":true}', "noteMonitorMute ui", "setMonitorActive true"],
  },
  {
    rule: "a monitor mute of a mid-level bus does not taint its descendants or siblings",
    run: (m) => m.setMute("music", true),
    tainted: ["master", "music"],
    calls: ['setMonitor music {"mute":true}', "noteMonitorMute music", "setMonitorActive true"],
  },
  {
    rule: "a monitor mute of master taints master only",
    run: (m) => m.setMute("master", true),
    tainted: ["master"],
    calls: ['setMonitor master {"mute":true}', "noteMonitorMute master", "setMonitorActive true"],
  },
  {
    rule: "an unmetered bus carries no mark; its ancestors and master still do",
    run: (m) => m.setMute("amb", true),
    tainted: ["master"],
    calls: ['setMonitor amb {"mute":true}', "noteMonitorMute amb", "setMonitorActive true"],
  },
  {
    rule: "a monitor solo taints every meter (and not the unmetered bus)",
    run: (m) => m.setSolo("ui", true),
    tainted: METERED,
    calls: ['setMonitor ui {"solo":true}', "noteMonitorSolo", "setMonitorActive true"],
  },
  {
    rule: "unmuting clears nothing",
    run: (m) => { m.setMute("ui", true); m.setMute("ui", false); },
    tainted: ["master", "sfx", "ui"],
    calls: ['setMonitor ui {"mute":true}', "noteMonitorMute ui", "setMonitorActive true", 'setMonitor ui {"mute":false}', "setMonitorActive false"],
  },
  {
    rule: "solo off clears nothing",
    run: (m) => { m.setSolo("hit", true); m.setSolo("hit", false); },
    tainted: METERED,
    calls: ['setMonitor hit {"solo":true}', "noteMonitorSolo", "setMonitorActive true", 'setMonitor hit {"solo":false}', "setMonitorActive false"],
  },
  {
    rule: "reset(all) clears the marks",
    run: (m) => { m.setSolo("ui", true); m.noteReset("all"); },
    tainted: [],
    calls: ['setMonitor ui {"solo":true}', "noteMonitorSolo", "setMonitorActive true"],
  },
  {
    rule: "reset(integrated) clears the marks",
    run: (m) => { m.setMute("ui", true); m.noteReset("integrated"); },
    tainted: [],
    calls: ['setMonitor ui {"mute":true}', "noteMonitorMute ui", "setMonitorActive true"],
  },
  {
    rule: "reset(maxPeak) leaves the marks",
    run: (m) => { m.setMute("ui", true); m.noteReset("maxPeak"); },
    tainted: ["master", "sfx", "ui"],
    calls: ['setMonitor ui {"mute":true}', "noteMonitorMute ui", "setMonitorActive true"],
  },
  {
    rule: "a reset of one meter clears only that meter",
    run: (m) => { m.setMute("ui", true); m.noteReset("all", "sfx"); },
    tainted: ["master", "ui"],
    calls: ['setMonitor ui {"mute":true}', "noteMonitorMute ui", "setMonitorActive true"],
  },
  {
    rule: "Play with loudnessResetOnPlay clears the marks",
    run: (m) => { m.setSolo("ui", true); m.notePlay(true); },
    tainted: [],
    calls: ['setMonitor ui {"solo":true}', "noteMonitorSolo", "setMonitorActive true"],
  },
  {
    rule: "Play without loudnessResetOnPlay keeps the marks",
    run: (m) => { m.setSolo("ui", true); m.notePlay(false); },
    tainted: METERED,
    calls: ['setMonitor ui {"solo":true}', "noteMonitorSolo", "setMonitorActive true"],
  },
  {
    rule: "a mute after a reset taints afresh",
    run: (m) => { m.setMute("ui", true); m.noteReset("all"); m.setMute("hit", true); },
    tainted: ["master", "sfx", "hit"],
    calls: ['setMonitor ui {"mute":true}', "noteMonitorMute ui", "setMonitorActive true", 'setMonitor hit {"mute":true}', "noteMonitorMute hit"],
  },
  {
    rule: "a second solo after a reset taints every meter again",
    run: (m) => { m.setSolo("ui", true); m.noteReset("all"); m.setSolo("music", true); },
    tainted: METERED,
    calls: ['setMonitor ui {"solo":true}', "noteMonitorSolo", "setMonitorActive true", 'setMonitor music {"solo":true}', "noteMonitorSolo"],
  },
  {
    rule: "setting a control to the value it has makes no call and no mark",
    run: (m) => { m.setMute("ui", false); m.setSolo("ui", false); },
    tainted: [],
    calls: [],
  },
];

describe("monitor taint (§6.6, R20): one row per rule", () => {
  for (const row of SPEC) {
    it(row.rule, () => {
      const { model, calls } = setup();
      row.run(model);
      expect(model.taintedMeters()).toEqual(ALL.filter((n) => row.tainted.includes(n)));
      expect(calls).toEqual(row.calls);
    });
  }

  it("says why: own mute, a mute below, a solo", () => {
    const { model } = setup();
    model.setMute("ui", true);
    expect(model.taint("ui")).toEqual([{ kind: "mute", bus: "ui" }]);
    expect(model.taint("sfx")).toEqual([{ kind: "mute-below", bus: "ui" }]);
    expect(model.taint("master")).toEqual([{ kind: "mute-below", bus: "ui" }]);
    expect(model.taint("music")).toEqual([]);
    model.setSolo("calm", true);
    expect(model.taint("music")).toEqual([{ kind: "solo", bus: "calm" }]);
    expect(model.taint("ui")).toEqual([{ kind: "mute", bus: "ui" }, { kind: "solo", bus: "calm" }]);
  });

  it("taint never comes from anything but a monitor control: a fresh model, setBuses and unknown buses mark nothing", () => {
    const { model, calls } = setup();
    expect(model.taintedMeters()).toEqual([]);
    expect(model.setMute("nope", true)).toBe(false);
    expect(model.setSolo("nope", true)).toBe(false);
    model.setBuses(BUSES, METERED);
    expect(model.taintedMeters()).toEqual([]);
    expect(model.active).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("monitor mute and solo: which buses are heard", () => {
  it("everything is audible with no controls", () => {
    const { model } = setup();
    expect(audibleSet(model)).toEqual([...ALL].sort());
  });

  it("a solo keeps the bus, its descendants and its ancestors", () => {
    const { model } = setup();
    model.setSolo("sfx", true);
    expect(audibleSet(model)).toEqual(["hit", "master", "sfx", "ui"]);
  });

  it("a solo of a leaf keeps its ancestors, not its siblings", () => {
    const { model } = setup();
    model.setSolo("ui", true);
    expect(audibleSet(model)).toEqual(["master", "sfx", "ui"]);
  });

  it("several solos union", () => {
    const { model } = setup();
    model.setSolo("ui", true);
    model.setSolo("calm", true);
    expect(audibleSet(model)).toEqual(["calm", "master", "music", "sfx", "ui"]);
  });

  it("releasing one of two solos leaves the other's set; releasing the last restores everything", () => {
    const { model } = setup();
    model.setSolo("ui", true);
    model.setSolo("calm", true);
    model.setSolo("ui", false);
    expect(audibleSet(model)).toEqual(["calm", "master", "music"]);
    model.setSolo("calm", false);
    expect(audibleSet(model)).toEqual([...ALL].sort());
  });

  it("a mute silences the bus and its descendants only", () => {
    const { model } = setup();
    model.setMute("sfx", true);
    expect(audibleSet(model)).toEqual(["amb", "calm", "master", "music"]);
  });

  it("a mute wins over a solo on the same bus and under a soloed one", () => {
    const { model } = setup();
    model.setSolo("sfx", true);
    model.setMute("ui", true);
    expect(audibleSet(model)).toEqual(["hit", "master", "sfx"]);
    model.setMute("sfx", true);
    expect(audibleSet(model)).toEqual(["master"]);
  });

  it("agrees with the Mixer's own resolution (same tree, same controls)", () => {
    const settings = parseAudioSettings({
      buses: [
        { name: "master" }, { name: "sfx", parent: "master" }, { name: "ui", parent: "sfx" }, { name: "hit", parent: "sfx" },
        { name: "music", parent: "master" }, { name: "calm", parent: "music" }, { name: "amb", parent: "master" },
      ],
    }).settings;
    const mixer = new Mixer(settings);
    const { model } = setup();
    const scenarios: Array<[string[], string[]]> = [[[], []], [["sfx"], []], [["ui", "calm"], []], [["sfx"], ["ui"]], [[], ["music"]]];
    for (const [solos, mutes] of scenarios) {
      for (const n of ALL) { mixer.setMonitor(n, { mute: false, solo: false }); }
      model.clearAll();
      for (const s of solos) { mixer.setMonitor(s, { solo: true }); model.setSolo(s, true); }
      for (const mu of mutes) { mixer.setMonitor(mu, { mute: true }); model.setMute(mu, true); }
      for (const n of ALL) expect(model.audible(n), `${n} under solo [${solos}] mute [${mutes}]`).toBe(mixer.resolve(n)!.effectiveGain > 0);
    }
  });
});

describe("monitor controls: state and calls", () => {
  it("toggle flips, and active follows any control", () => {
    const { model, calls } = setup();
    expect(model.toggleMute("ui")).toBe(true);
    expect(model.isMuted("ui")).toBe(true);
    expect(model.active).toBe(true);
    model.toggleSolo("hit");
    expect(model.isSoloed("hit")).toBe(true);
    model.toggleMute("ui");
    expect(model.active).toBe(true);
    model.toggleSolo("hit");
    expect(model.active).toBe(false);
    // setMonitorActive fires only on the two edges.
    expect(calls.filter((c) => c.startsWith("setMonitorActive"))).toEqual(["setMonitorActive true", "setMonitorActive false"]);
  });

  it("clearAll turns every mute and solo off, one setMonitor per bus, active false, taint stays", () => {
    const { model, calls } = setup();
    model.setMute("ui", true);
    model.setSolo("ui", true);
    model.setSolo("calm", true);
    calls.length = 0;
    model.clearAll();
    expect(calls).toEqual(['setMonitor ui {"mute":false,"solo":false}', 'setMonitor calm {"solo":false}', "setMonitorActive false"]);
    expect(model.active).toBe(false);
    expect(audibleSet(model)).toEqual([...ALL].sort());
    expect(model.taintedMeters()).toEqual(METERED);
  });

  it("clearAll with nothing on makes no call", () => {
    const { model, calls } = setup();
    model.clearAll();
    expect(calls).toEqual([]);
  });

  it("setBuses drops controls on a removed bus silently and keeps the rest", () => {
    const { model, calls } = setup();
    model.setMute("ui", true);
    model.setMute("hit", true);
    calls.length = 0;
    model.setBuses(BUSES.filter((b) => b.name !== "ui"), METERED.filter((n) => n !== "ui"));
    expect(model.isMuted("ui")).toBe(false);
    expect(model.isMuted("hit")).toBe(true);
    expect(model.taint("ui")).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("works with no host members (no Play Engine yet)", () => {
    const model = createMonitorModel({ host: {} });
    model.setBuses(BUSES);
    expect(() => { model.setMute("ui", true); model.setSolo("hit", true); model.clearAll(); }).not.toThrow();
  });
});

describe("monitor controls are never saved", () => {
  it("an injected commit function is never called by any gesture", () => {
    let commits = 0;
    // `commit` is not part of MonitorHost; passing one anyway (as the Mixer panel's host does) must stay unused.
    const host = { commit: () => { commits++; }, setMonitor() {}, noteMonitorMute() {}, noteMonitorSolo() {}, setMonitorActive() {} } as MonitorHost;
    const model = createMonitorModel({ host });
    model.setBuses(BUSES);
    model.setMute("ui", true); model.toggleMute("ui"); model.setSolo("hit", true); model.toggleSolo("hit");
    model.setMute("master", true); model.clearAll(); model.noteReset("all"); model.notePlay(true);
    model.setBuses(BUSES.slice(0, 3));
    expect(commits).toBe(0);
  });
});
