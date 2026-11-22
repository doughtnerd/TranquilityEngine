// ADR 0330: the mixer runs the `audio.json` mix natively — the VCA lane, mute silencing a bus and its sends, returns as
// send-fed buses with their own lanes, blending snapshots (priority, Add, fades, hold, conditions), effect-parameter
// overrides on the live effects, main-thread automation, the mix model's live ops through `apply`, and the editor's
// legacy view written back at configure (decision D2). Through the mixer's interface (`Bus`, `resolve`, `laneGain`,
// `apply`, `audioSettings`) with a fake live target.
import { describe, expect, it, vi } from "vitest";
import { CORE_LIVE_CAPS } from "./busCapability";
import { Lane, Mixer, type MixOpTarget } from "./mixer";
import type { ApplyResult, MixOp } from "./mixOps";
import { mixJsonOf, parseAudioProject } from "./project/format";
import { legacySectionOf } from "./project/runtimeView";
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
const reverbSend = (m: Mixer, bus: string) => (m.resolve(bus)!.effects.find((e) => e.type === "reverb") as Extract<BusEffect, { type: "reverb" }> | undefined)?.send;
const lowpass = (m: Mixer, bus: string) => (m.resolve(bus)!.effects.find((e) => e.type === "lowpass") as Extract<BusEffect, { type: "lowpass" }> | undefined)?.frequency;

describe("the mixer runs the audio.json model (ADR 0330)", () => {
  it("hands its backends the bus view: faders without VCAs, the reverb send at its level plus the return's", () => {
    const { m } = rig();
    expect(m.busNames).toEqual(["Master", "Music", "SFX", "Steps"]);
    expect(m.returnNames).toEqual(["Reverb"]);
    expect(db(m.audioSettings.buses[2]!.volume)).toBeCloseTo(0, 9);
    expect(db(reverbSend(m, "SFX")!)).toBeCloseTo(-15, 6);
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

  it("mute silences the bus and its sends (project, script and monitor mutes); a muted return silences the sends into it", () => {
    const { m } = rig();
    expect(reverbSend(m, "SFX")!).toBeGreaterThan(0);
    m.bus("SFX").mute = true;
    m.update(0);
    expect(reverbSend(m, "SFX")).toBe(0);
    expect(m.bus("Steps").effectiveGain).toBe(0);
    m.bus("SFX").mute = false;
    m.setMonitor("Reverb", { mute: true });
    m.update(0);
    expect(reverbSend(m, "SFX")).toBe(0);
    m.setMonitor("Reverb", { mute: false });
    m.update(0);
    expect(db(reverbSend(m, "SFX")!)).toBeCloseTo(-15, 6);
  });

  it("returns: their own lanes (script volume, snapshot offsets) move the sends into them; solo keeps them audible", () => {
    const { m, run } = rig();
    m.bus("Reverb").volume = 0.5;
    m.update(0);
    expect(reverbSend(m, "SFX")!).toBeCloseTo(Math.pow(10, -15 / 20) * 0.5, 6);
    m.bus("Reverb").volume = 1;
    m.startSnapshot("Under");
    run(1.05);
    expect(db(reverbSend(m, "SFX")!)).toBeCloseTo(-21, 4);
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

  it("send automation runs on the main thread from the parameter", () => {
    const { m } = rig();
    m.setParameter("threat", 1);
    m.update(0);
    expect(db(reverbSend(m, "SFX")!)).toBeCloseTo(-9, 6);
  });

  it("live ops: a VCA, a return and a snapshot edit apply to the model; the bus view's changes go out as the old ops", () => {
    const { m, sent } = rig();
    expect(m.apply({ op: "setVca", name: "Gameplay", vca: { name: "Gameplay", volumeDb: -12, members: ["SFX"] } })).toEqual({ ok: true, class: "direct" });
    expect(sent).toEqual([]); // the VCA lane is main's
    m.update(0.02); // the VCA lane ramps over DRAG_RAMP_MS
    expect(db(m.laneGain("SFX", Lane.vca))).toBeCloseTo(-12, 6);
    expect(m.apply({ op: "setReturn", name: "Reverb", ret: { name: "Reverb", output: "Master", volumeDb: -9, mute: false, effects: [{ id: "fx1", type: "reverb", on: true, params: { mix: 100 } }] } }).ok).toBe(true);
    expect(sent.map((o) => o.op)).toEqual(["setEffect"]); // the reverb send's level
    expect(db(m.audioSettings.buses[2]!.effects[0]!.type === "reverb" ? (m.audioSettings.buses[2]!.effects[0] as { send: number }).send : 0)).toBeCloseTo(-21, 6);
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

  it("D2: a legacy view the editor's panels edited is written back into the mix at configure; an unedited one changes nothing", () => {
    const p = project();
    const legacy = legacySectionOf(p);
    const same = new Mixer({ ...defaultAudioSettings(), ...legacy, mix: mixJsonOf(p) });
    expect(same.audioProject.vcas).toEqual(p.vcas);
    const edited = { ...legacy, buses: legacy.buses.map((b) => (b.name === "Music" ? { ...b, volume: 0.1 } : b)) };
    const m = new Mixer({ ...defaultAudioSettings(), ...edited, mix: mixJsonOf(p) });
    expect(db(m.bus("Music").authoredVolume)).toBeCloseTo(-20, 6);
    expect(m.audioProject.vcas).toEqual(p.vcas); // what the legacy view can't express is kept
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
    expect(reverbSend(m, "SFX")).toBe(0.5);
    warn.mockRestore();
  });
});
