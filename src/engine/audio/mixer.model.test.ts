// ADR 0344: the mixer runs the `audio.json` mix natively — the VCA lane, mute silencing a bus and its sends, returns as
// send-fed buses with their own lanes, blending snapshots (priority, Add, fades, hold, conditions), effect-parameter
// overrides on the live effects, main-thread automation, the mix model's live ops through `apply`, and the editor's
// legacy view written back at configure (decision D2). Through the mixer's interface (`Bus`, `resolve`, `laneGain`,
// `apply`, `audioSettings`) with a fake live target.
import { describe, expect, it, vi } from "vitest";
import { CORE_LIVE_CAPS } from "./busCapability";
import { Lane, Mixer, type MixOpTarget } from "./mixer";
import type { ApplyResult, MixOp } from "./mixOps";
import { mixJsonOf, parseAudioProject } from "./project/format";
import { coreSectionOf } from "./project/runtimeView";
import type { AudioProject } from "./project/types";
import { defaultAudioSettings, type AudioSettings, type BusEffect } from "./settings";

const MIX = {
  format: "myco.audio@1",
  parameters: [{ name: "threat", min: 0, max: 1, default: 0 }, { name: "state", labels: ["Play", "Paused"], default: "Play" }],
  buses: [
    { name: "Master", parent: null },
    { name: "Music", parent: "Master", volumeDb: -6, effects: [{ id: "fx1", type: "lowpass", params: { cutoff: 18000 } }] },
    { name: "SFX", parent: "Master", sends: [{ to: "Reverb", levelDb: -12 }] },
    { name: "Steps", parent: "SFX" },
  ],
  returns: [{ name: "Reverb", output: "Master", volumeDb: -3, effects: [{ id: "fx1", type: "reverb", params: { mix: 100 } }] }],
  vcas: [{ name: "Gameplay", volumeDb: -6, members: ["SFX"] }],
  automation: [{ on: "SFX", target: "send:Reverb", parameter: "threat", curve: [[0, 0], [1, 6]] }],
  snapshots: [
    { name: "Under", priority: 20, fadeInMs: 1000, fadeOutMs: 1000, buses: { Music: -12, Reverb: -6 }, effects: { Music: { fx1: { cutoff: 800 } } } },
    { name: "Pause", priority: 40, fadeInMs: 0, fadeOutMs: 0, holdMs: 500, start: { kind: "conditions", match: "all", conditions: [{ parameter: "state", op: "is", value: "Paused" }] }, buses: { Music: -20 } },
    { name: "Tension", combine: "add", fadeInMs: 0, buses: { Music: -2 } },
    { name: "Room", start: { kind: "base" }, buses: { SFX: -1 } },
  ],
};

const project = (over: Partial<Record<keyof typeof MIX, unknown>> = {}): AudioProject => {
  const r = parseAudioProject({ ...MIX, ...over });
  expect(r.problems).toEqual([]);
  return r.project;
};
const settingsOf = (p: AudioProject): AudioSettings => ({ ...defaultAudioSettings(), mix: mixJsonOf(p) });

function rig(p = project()) {
  const m = new Mixer(settingsOf(p));
  const sent: MixOp[] = [];
  const target: MixOpTarget = {
    liveCaps: CORE_LIVE_CAPS,
    sendOp: (op, cls): ApplyResult => { sent.push(op); m._applyLive(op); return { ok: true, class: cls }; },
  };
  m._setOpTarget(target);
  const run = (seconds: number, step = 1 / 60) => { for (let t = 0; t < seconds - 1e-9; t += step) m.update(step); };
  return { m, sent, run };
}
const db = (g: number) => 20 * Math.log10(g);
/** `bus`'s live send into the Reverb return (`_busSends`, what the core backend writes as `BUS_SENDS`). */
const reverbSend = (m: Mixer, bus: string) => m._busSends(bus)?.find((s) => s.to === "Reverb");
const lowpass = (m: Mixer, bus: string) => (m.resolve(bus)!.effects.find((e) => e.type === "lowpass") as Extract<BusEffect, { type: "lowpass" }> | undefined)?.frequency;

describe("the mixer runs the audio.json model (ADR 0344)", () => {
  it("hands its backends the bus view: faders without VCAs, returns as buses after the buses, sends at their level", () => {
    const { m } = rig();
    expect(m.busNames).toEqual(["Master", "Music", "SFX", "Steps", "Reverb"]);
    expect(m.returnNames).toEqual(["Reverb"]);
    expect(db(m.audioSettings.buses[2]!.volume)).toBeCloseTo(0, 9);
    const ret = m.audioSettings.buses[4]!;
    expect(ret).toMatchObject({ name: "Reverb", parent: "Master", mute: false, effects: [{ type: "fx", fx: "reverb" }] });
    expect(db(ret.volume)).toBeCloseTo(-3, 6);
    expect(m.audioSettings.buses[2]!.sends).toEqual([{ to: "Reverb", level: expect.closeTo(Math.pow(10, -12 / 20), 9) }]);
    expect(reverbSend(m, "SFX")).toEqual({ to: "Reverb", level: expect.closeTo(Math.pow(10, -12 / 20), 9), muted: false });
    expect(m._busSends("Music")).toEqual([]);
    expect(m.has("Reverb")).toBe(false); // a sound can't play on a return
    expect(m.resolveOutput("Reverb")).toBe("Master");
  });

  it("VCA lane: offsets its members and everything under them; the wire's authored lane carries fader x VCA", () => {
    const { m } = rig();
    expect(db(m.laneGain("SFX", Lane.vca))).toBeCloseTo(-6, 6);
    expect(m.laneGain("Steps", Lane.vca)).toBe(1);
    expect(db(m._lanes("SFX")!.authored.to)).toBeCloseTo(-6, 6);
    expect(db(m.bus("Steps").effectiveGain)).toBeCloseTo(-6 - 1, 6); // VCA on SFX, the base snapshot's -1 dB
    expect(m.bus("SFX").authoredVolume).toBe(1); // the fader alone
  });

  it("mute silences the bus and its sends, keeping their level (project, script and monitor mutes); a muted return is silent itself", () => {
    const { m } = rig();
    const level = Math.pow(10, -12 / 20);
    expect(reverbSend(m, "SFX")).toMatchObject({ muted: false });
    m.bus("SFX").mute = true;
    m.update(0);
    expect(reverbSend(m, "SFX")).toEqual({ to: "Reverb", level: expect.closeTo(level, 9), muted: true });
    expect(m.bus("Steps").effectiveGain).toBe(0);
    m.bus("SFX").mute = false;
    m.setMonitor("SFX", { mute: true });
    m.update(0);
    expect(reverbSend(m, "SFX")).toMatchObject({ muted: true });
    m.setMonitor("SFX", { mute: false });
    expect(m.apply({ op: "setMute", name: "SFX", value: true }).ok).toBe(true);
    expect(reverbSend(m, "SFX")).toMatchObject({ muted: true });
    m.apply({ op: "setMute", name: "SFX", value: false });
    expect(reverbSend(m, "SFX")).toEqual({ to: "Reverb", level: expect.closeTo(level, 9), muted: false });
    // A muted return: its own lanes (it is a bus of the view); the sends into it run on.
    m.setMonitor("Reverb", { mute: true });
    m.update(0);
    expect(m.resolve("Reverb")!.gain).toBe(0);
    expect(reverbSend(m, "SFX")).toMatchObject({ muted: false });
    m.setMonitor("Reverb", { mute: false });
    expect(m.apply({ op: "setMute", name: "Reverb", value: true }).ok).toBe(true);
    expect(m.bus("Reverb").authoredMute).toBe(true);
    expect(m.resolve("Reverb")!.gain).toBe(0);
  });

  it("returns: their own lanes (script volume, snapshot offsets), the sends into them untouched; solo keeps them audible", () => {
    const { m, run } = rig();
    m.bus("Reverb").volume = 0.5;
    m.update(0);
    expect(m.laneGain("Reverb", Lane.runtime)).toBe(0.5);
    expect(m._lanes("Reverb")!.runtime.to).toBe(0.5); // the lane writer's: a core lane like a bus's
    expect(db(m.resolve("Reverb")!.gain)).toBeCloseTo(-3 + db(0.5), 6);
    m.bus("Reverb").volume = 1;
    m.startSnapshot("Under");
    run(1.05);
    expect(db(m.laneGain("Reverb", Lane.snapshot))).toBeCloseTo(-6, 4);
    expect(db(reverbSend(m, "SFX")!.level)).toBeCloseTo(-12, 6);
    m.bus("Steps").solo = true;
    expect(m.resolve("Reverb")!.gain).toBeGreaterThan(0);
    expect(m.resolve("Music")!.gain).toBe(0);
  });

  it("snapshots blend: Override by priority, Add on top; an effect override reaches the live effects, blending from the base", () => {
    const { m, run } = rig();
    m.startSnapshot("Under");
    run(0.5);
    expect(db(m.laneGain("Music", Lane.snapshot))).toBeCloseTo(-6, 0);
    const half = lowpass(m, "Music")!;
    expect(half).toBeLessThan(18000);
    expect(half).toBeGreaterThan(800);
    run(0.6);
    expect(db(m.laneGain("Music", Lane.snapshot))).toBeCloseTo(-12, 6);
    expect(lowpass(m, "Music")).toBe(800);
    m.startSnapshot("Tension");
    m.update(0);
    expect(db(m.laneGain("Music", Lane.snapshot))).toBeCloseTo(-14, 6);
    expect(m.snapshotActive("Under")).toBe(true);
    m.stopSnapshot("Under", 0);
    m.stopSnapshot("Tension", 0);
    m.update(0);
    expect(m.laneGain("Music", Lane.snapshot)).toBe(1);
    expect(lowpass(m, "Music")).toBe(18000);
  });

  it("conditions start on Audio.setParameter (labels by name); the hold keeps a snapshot on past its conditions", () => {
    const { m, run } = rig();
    m.setParameter("state", "Paused");
    m.update(0);
    expect(db(m.laneGain("Music", Lane.snapshot))).toBeCloseTo(-20, 6);
    m.setParameter("state", "Play");
    run(0.25);
    expect(db(m.laneGain("Music", Lane.snapshot))).toBeCloseTo(-20, 6); // held 500 ms
    run(0.3);
    expect(m.laneGain("Music", Lane.snapshot)).toBe(1);
  });

  it("an unknown label is ignored, with one warning naming it and the labels (Q21, ADR 0386)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { m, run } = rig();
      m.setParameter("state", "Paused");
      m.update(0);
      m.setParameter("state", "Pasued");
      m.setParameter("state", "Pasued");
      run(1); // past the 500 ms hold: the parameter still reads "Paused", so the snapshot stays on
      expect(db(m.laneGain("Music", Lane.snapshot))).toBeCloseTo(-20, 6);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/"state" has no label "Pasued".*"Play", "Paused"/);
    } finally {
      warn.mockRestore();
    }
  });

  it("the base snapshot is on from the start and can't be stopped; the shorthand fades the code snapshots only", () => {
    const { m, run } = rig();
    expect(db(m.laneGain("SFX", Lane.snapshot))).toBeCloseTo(-1, 6);
    expect(m.stopSnapshot("Room")).toBe(false);
    m.snapshot("Tension", 0);
    expect(m.currentSnapshot).toBe("Tension");
    m.snapshot("Under", 0.2);
    run(0.3);
    expect(m.snapshotActive("Tension")).toBe(false);
    expect(m.currentSnapshot).toBe("Under");
    m.clearSnapshot(0);
    m.update(0);
    expect(m.currentSnapshot).toBeNull();
    expect(db(m.laneGain("SFX", Lane.snapshot))).toBeCloseTo(-1, 6);
  });

  it("a return's inserts take snapshot overrides (held against automation), and its fx: and volume automation are the core's, as a bus's", () => {
    const p = project({
      returns: [{ name: "Reverb", output: "Master", volumeDb: -3, effects: [{ id: "fx1", type: "delay", params: { time: 250, feedback: 30, mix: 100 } }] }],
      automation: [
        { on: "Reverb", target: "fx:fx1:feedback", parameter: "threat", curve: [[0, 10], [1, 60]] },
        { on: "Reverb", target: "volume", parameter: "threat", curve: [[0, 0], [1, -6]] },
      ],
      snapshots: [{ name: "Long", fadeInMs: 0, fadeOutMs: 0, effects: { Reverb: { fx1: { time: 400 } } } }],
    });
    const { m } = rig(p);
    const delay = () => m._busEffects("Reverb")![0] as Extract<BusEffect, { type: "fx" }>;
    // ABI 4.8: the core runs the feedback's automation; the live effect carries the authored value.
    expect(delay().params).toMatchObject({ time: 250, feedback: 30 });
    m.setParameter("threat", 1);
    m.update(0);
    expect(delay().params).toMatchObject({ time: 250, feedback: 30 });
    expect(delay().held).toBeUndefined();
    m.startSnapshot("Long");
    m.update(0);
    // The override replaces the value and holds it against the core's automation while in force.
    expect(delay().params).toMatchObject({ time: 400, feedback: 30 });
    expect(delay().held).toEqual(["time"]);
    // Effect and volume automation of the return go to the core (the view's automation), as for a bus.
    expect(m.audioSettings.automation).toEqual([
      { bus: "Reverb", parameter: "threat", target: "fx", effect: 0, param: 1, curve: [[0, 10], [1, 60]] },
      { bus: "Reverb", parameter: "threat", target: "volume", curve: [[0, 1], [1, expect.closeTo(Math.pow(10, -6 / 20), 9)]] },
    ]);
  });

  it("send automation runs in the core (ABI 4.8): the live send keeps its level and the view carries the automation", () => {
    const { m } = rig();
    m.setParameter("threat", 1);
    m.update(0);
    expect(db(reverbSend(m, "SFX")!.level)).toBeCloseTo(-12, 6);
    expect(m.audioSettings.automation.filter((a) => a.target === "send")).toEqual([{ bus: "SFX", parameter: "threat", target: "send", to: "Reverb", curve: expect.any(Array) }]);
  });

  it("live ops: a VCA, a return and a snapshot edit apply to the model; the bus view's changes go out as the old ops", () => {
    const { m, sent } = rig();
    expect(m.apply({ op: "setVca", name: "Gameplay", vca: { name: "Gameplay", volumeDb: -12, members: ["SFX"] } })).toEqual({ ok: true, class: "direct" });
    expect(sent).toEqual([]); // the VCA lane is main's
    m.update(0.02); // the VCA lane ramps over DRAG_RAMP_MS
    expect(db(m.laneGain("SFX", Lane.vca))).toBeCloseTo(-12, 6);
    expect(m.apply({ op: "setReturn", name: "Reverb", ret: { name: "Reverb", output: "Master", volumeDb: -9, mute: false, effects: [{ id: "fx1", type: "reverb", on: true, params: { mix: 100 } }] } }).ok).toBe(true);
    expect(sent).toEqual([{ op: "setBus", bus: "Reverb", key: "volume", value: expect.closeTo(Math.pow(10, -9 / 20), 9) }]); // the return's fader
    m.update(0.02);
    expect(db(m.laneGain("Reverb", Lane.authored))).toBeCloseTo(-9, 6);
    expect(m.audioProject.returns[0]!.volumeDb).toBe(-9);
    // A send: the view's sends and the live ones follow (no old op carries them).
    expect(m.apply({ op: "setSend", bus: "Music", to: "Reverb", levelDb: -20 })).toEqual({ ok: true, class: "direct" });
    expect(m.audioSettings.buses[1]!.sends).toEqual([{ to: "Reverb", level: expect.closeTo(0.1, 9) }]);
    expect(reverbSend(m, "Music")).toEqual({ to: "Reverb", level: expect.closeTo(0.1, 9), muted: false });
    // A renamed return keeps its bus (renameBus, no structural edit), and the sends into it follow.
    sent.length = 0;
    expect(m.apply({ op: "setReturn", name: "Hall", from: "Reverb", ret: { name: "Hall", output: "Master", volumeDb: -9, mute: false, effects: [{ id: "fx1", type: "reverb", on: true, params: { mix: 100 } }] } }).ok).toBe(true);
    expect(sent).toEqual([{ op: "renameBus", from: "Reverb", to: "Hall" }]);
    expect(m.returnNames).toEqual(["Hall"]);
    expect(m._busSends("SFX")!.map((s) => s.to)).toEqual(["Hall"]);
    m.startSnapshot("Tension");
    m.update(0);
    m.apply({ op: "setSnapshotLevel", snapshot: "Tension", target: "Music", db: -5 });
    m.update(0.05);
    expect(db(m.laneGain("Music", Lane.snapshot))).toBeCloseTo(-5, 6);
    expect(m.audioProject.snapshots.find((s) => s.name === "Tension")!.buses.Music).toBe(-5);
    expect(m.apply({ op: "setMute", name: "Nope", value: true })).toEqual({ ok: false, class: "none" });
  });

  it("an old op lifts into the model: a fader in dB, a renamed snapshot keeps its trigger and stays on", () => {
    const { m } = rig();
    m.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.25 });
    expect(m.audioProject.buses[1]!.volumeDb).toBeCloseTo(db(0.25), 6);
    m.startSnapshot("Under", 0);
    const index = m.audioSettings.snapshots.findIndex((s) => s.name === "Under");
    m.apply({ op: "renameSnapshot", index, name: "Deep" });
    expect(m.audioProject.snapshots.find((s) => s.name === "Deep")!.priority).toBe(20);
    expect(m.snapshotActive("Deep")).toBe(true);
  });

  it("runs the mix it is given: the old keys beside it are a view of it, never written back", () => {
    const p = project();
    const view = coreSectionOf(p);
    const edited = { ...view, buses: view.buses.map((b) => (b.name === "Music" ? { ...b, volume: 0.1 } : b)) };
    const m = new Mixer({ ...defaultAudioSettings(), ...edited, mix: mixJsonOf(p) });
    expect(m.audioProject.buses.find((b) => b.name === "Music")!.volumeDb).toBe(p.buses.find((b) => b.name === "Music")!.volumeDb);
    expect(m.audioProject.vcas).toEqual(p.vcas);
  });

  it("settings without a mix (the old section) are migrated: snapshots run as the model's, a reverb send as a return", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = new Mixer({
      ...defaultAudioSettings(),
      buses: [{ name: "Master", volume: 1, mute: false, effects: [] }, { name: "SFX", parent: "Master", volume: 1, mute: false, effects: [{ type: "reverb", send: 0.5 }] }],
      snapshots: [{ name: "Quiet", volumes: { SFX: 0.5 }, lowpass: {} }],
    });
    expect(m.returnNames).toEqual(["Reverb"]);
    m.snapshot("Quiet", 0);
    expect(m.laneGain("SFX", Lane.snapshot)).toBe(0.5);
    expect(reverbSend(m, "SFX")).toEqual({ to: "Reverb", level: 0.5, muted: false });
    expect(m.audioSettings.buses.find((b) => b.name === "SFX")!.effects).toEqual([]); // the view holds no reverb send effect
    warn.mockRestore();
  });
});

describe("occlusion curves live (ADR 0362 item 6)", () => {
  it("apply sets the settings the occlusion pass reads, and clears them; nothing is sent to the backend", () => {
    const { m, sent } = rig();
    expect(m.audioSettings.occlusion.curves).toBeUndefined();
    expect(m.apply({ op: "setOcclusionCurves", curves: { lowpass: [[0, 20000], [1, 900]] } })).toEqual({ ok: true, class: "config" });
    expect(m.audioSettings.occlusion.curves).toEqual({ lowpass: [[0, 20000], [1, 900]] });
    expect(m.audioProject.settings.occlusion.curves).toEqual({ lowpass: [[0, 20000], [1, 900]] });
    expect(m.apply({ op: "setOcclusionCurves", curves: null }).ok).toBe(true);
    expect(m.audioSettings.occlusion.curves).toBeUndefined();
    expect(sent).toEqual([]);
  });
});
