import { describe, expect, it, vi } from "vitest";
import { Mixer } from "../audio/mixer";
import { parseAudioSettings, defaultAudioSettings } from "../audio/settings";
import { BusGraph } from "../audio/busGraph";

const mk = (input: unknown) => new Mixer(parseAudioSettings(input).settings);

describe("audio settings (ADR 0097)", () => {
  it("defaults to Master with Music, SFX, UI and Voice", () => {
    expect(defaultAudioSettings().buses.map((b) => b.name)).toEqual(["Master", "Music", "SFX", "UI", "Voice"]);
  });
  it("reports and repairs bad buses", () => {
    const { settings, problems } = parseAudioSettings({
      buses: [{ name: "Master" }, { name: "A", parent: "Nope" }, { name: "A" }, { name: "B", parent: "C" }, { name: "C", parent: "B" }, { name: "D", volume: 9, effects: [{ type: "bogus" }, { type: "reverb", send: 5 }] }],
      ducking: [{ target: "A", trigger: "A" }, { target: "A", trigger: "Zed" }],
      snapshots: [{ name: "S", volumes: { A: 0.5, Zed: 1 } }],
    });
    expect(settings.buses.map((b) => [b.name, b.parent])).toEqual([["Master", undefined], ["A", "Master"], ["B", "Master"], ["C", "B"], ["D", "Master"]]);
    expect(settings.buses[4].volume).toBe(2);
    expect(settings.buses[4].effects).toEqual([{ type: "reverb", send: 1 }]);
    expect(settings.ducking).toEqual([]);
    expect(settings.snapshots[0].volumes).toEqual({ A: 0.5 });
    expect(problems.length).toBeGreaterThanOrEqual(6);
  });
  it("needs an sdkPath for fmod", () => {
    expect(parseAudioSettings({ backend: "fmod" }).problems[0]).toMatch(/sdkPath/);
  });
});

describe("mixer", () => {
  it("multiplies gains up the tree and honours mute", () => {
    const m = mk({});
    m.bus("Master").volume = 0.5;
    m.bus("Music").volume = 0.5;
    expect(m.bus("Music").effectiveGain).toBeCloseTo(0.25);
    m.bus("Music").mute = true;
    expect(m.bus("Music").effectiveGain).toBe(0);
    expect(m.bus("SFX").effectiveGain).toBeCloseTo(0.5);
  });
  it("solo silences unrelated buses but not ancestors or descendants", () => {
    const m = mk({ buses: [{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "Battle", parent: "Music" }, { name: "SFX", parent: "Master" }] });
    m.bus("Music").solo = true;
    expect(m.bus("SFX").effectiveGain).toBe(0);
    expect(m.bus("Battle").effectiveGain).toBe(1);
    expect(m.bus("Music").effectiveGain).toBe(1);
    m.bus("Music").solo = false;
    expect(m.bus("SFX").effectiveGain).toBe(1);
  });
  it("warns once for an unknown bus and ignores its setters", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = mk({});
    m.bus("Nope").volume = 1;
    m.bus("Nope").mute = true;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(m.bus("Nope").exists).toBe(false);
    expect(m.resolveOutput("Nope")).toBe("Master");
    warn.mockRestore();
  });
  it("fades a bus over time", () => {
    const m = mk({});
    m.bus("Music").fadeTo(0, 1);
    m.update(0.5);
    expect(m.bus("Music").volume).toBeCloseTo(0.5);
    m.update(0.6);
    expect(m.bus("Music").volume).toBe(0);
  });
  it("fades to and from a snapshot", () => {
    const m = mk({ snapshots: [{ name: "Paused", volumes: { Music: 0.2, SFX: 0 }, lowpass: { Music: 800 } }] });
    m.snapshot("Paused", 1);
    m.update(0.5);
    expect(m.bus("Music").effectiveGain).toBeCloseTo(0.6);
    m.update(0.5);
    expect(m.bus("Music").effectiveGain).toBeCloseTo(0.2);
    expect(m.bus("SFX").effectiveGain).toBe(0);
    expect(m.resolve("Music")!.snapshotLowpass).toBeCloseTo(800);
    expect(m.currentSnapshot).toBe("Paused");
    m.clearSnapshot(0);
    m.update(0.016);
    expect(m.bus("Music").effectiveGain).toBe(1);
    expect(m.resolve("Music")!.snapshotLowpass).toBeNull();
  });
  it("ducks the target while the trigger has voices, then releases", () => {
    const m = mk({ ducking: [{ target: "Music", trigger: "Voice", amount: 0.4, attack: 0.1, release: 0.5 }] });
    m.update(0.1);
    expect(m.bus("Music").effectiveGain).toBe(1);
    m.voiceStarted("Voice");
    for (let i = 0; i < 60; i++) m.update(0.1);
    expect(m.bus("Music").effectiveGain).toBeCloseTo(0.4, 2);
    m.voiceEnded("Voice");
    for (let i = 0; i < 100; i++) m.update(0.1);
    expect(m.bus("Music").effectiveGain).toBeCloseTo(1, 2);
  });
  it("notifies listeners only when something changed", () => {
    const m = mk({});
    const cb = vi.fn();
    m.update(0.1);
    m.onChange(cb);
    m.update(0.1);
    expect(cb).not.toHaveBeenCalled();
    m.bus("SFX").volume = 0.3;
    m.update(0.1);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

/** A recording stand-in for the Web Audio context. */
function fakeContext() {
  const connections: [string, string][] = [];
  let n = 0;
  const param = () => ({ value: 0, setTargetAtTime: vi.fn() });
  const node = (kind: string, extra: object = {}) => {
    const id = `${kind}${n++}`;
    const o: Record<string, unknown> = { id, connect: (to: { id: string }) => connections.push([id, to.id]), disconnect: vi.fn(), ...extra };
    return o;
  };
  const ctx = {
    currentTime: 0, sampleRate: 8000,
    createGain: () => node("gain", { gain: param() }),
    createBiquadFilter: () => node("biquad", { frequency: param(), Q: param(), type: "" }),
    createDynamicsCompressor: () => node("comp", { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createConvolver: () => node("conv", { buffer: null }),
    createBuffer: (c: number, len: number) => ({ getChannelData: () => new Float32Array(len), numberOfChannels: c }),
  };
  return { ctx: ctx as unknown as BaseAudioContext, connections, dest: node("dest") as unknown as AudioNode };
}

describe("bus graph", () => {
  it("wires child buses into their parents and master into the destination, with effects and one shared reverb", () => {
    const { ctx, connections, dest } = fakeContext();
    const m = mk({ buses: [{ name: "Master" }, { name: "Music", parent: "Master", effects: [{ type: "lowpass", frequency: 500 }, { type: "compressor" }] }, { name: "SFX", parent: "Master", effects: [{ type: "reverb", send: 0.3 }] }, { name: "UI", parent: "Master", effects: [{ type: "reverb", send: 0.1 }] }] });
    const g = new BusGraph(ctx, dest, m);
    const inputOf = (bus: string) => (g.input(bus) as unknown as { id: string }).id;
    expect(connections.filter(([, to]) => to === inputOf("Master")).length).toBe(3); // Music, SFX, UI gains
    expect(connections.some(([, to]) => to === (dest as unknown as { id: string }).id)).toBe(true);
    expect(connections.filter(([from]) => from.startsWith("conv")).length).toBe(1); // one convolver, one output connection
    expect(g.input("Nope")).toBe(g.input("Master"));
    g.dispose();
  });
});
