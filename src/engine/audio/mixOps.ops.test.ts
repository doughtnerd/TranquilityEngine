// Mo1 (api-and-models §6.2, architecture §4.7): one case per op kind, each with its class; the byte form round trip;
// refusals; applyOpToDraft's write. The invert and diffOps property tests are L-Mo1a's (mixOps.test.ts); the per-op
// table here also checks both on each case.
import { describe, expect, it } from "vitest";
import {
  applyOpToDraft, applyOpToSettings, decodeMixOp, diffOps, encodeMixOp, invert, MAX_LOUDNESS_BUSES, MIX_OP_NAMES, opClass, opRefusal,
  type MixOp, type MixOpNameTable, type OpClass,
} from "./mixOps";
import { defaultAudioSettings, type AudioSettings } from "./settings";

/** Default settings plus a child bus, effects, a meter, a snapshot, a ducking rule, automation and authored targets. */
function base(): AudioSettings {
  const a = defaultAudioSettings();
  a.buses.push({ name: "Stems", parent: "Music", volume: 0.5, mute: true, effects: [{ type: "reverb", send: 0.3 }], maxVoices: 4, bed: "own", bedPriority: 200, meter: "loudness" });
  const music = a.buses.find((b) => b.name === "Music")!;
  music.effects = [{ type: "lowpass", frequency: 8000, q: 1 }, { type: "compressor", threshold: -20, knee: 10, ratio: 4, attack: 0.01, release: 0.2 }];
  a.buses.find((b) => b.name === "Voice")!.meter = "loudness";
  a.snapshots = [{ name: "Paused", volumes: { Music: 0.3, Stems: 0.2 }, lowpass: { Stems: 800 } }, { name: "Menu", volumes: {}, lowpass: {} }];
  a.ducking = [
    { target: "Music", trigger: "Voice", mode: "level", detector: "rms", threshold: -30, amount: 0.4, attack: 0.05, release: 0.4 },
    { target: "Stems", trigger: "Voice", mode: "presence", amount: 0.5, attack: 0.1, release: 0.6 },
  ];
  a.parameters = [{ name: "Intensity", min: 0, max: 1, default: 0, seekSpeed: 0 }];
  a.automation = [{ bus: "Stems", parameter: "Intensity", target: "volume", curve: [[0, 0.4], [1, 1, "smooth"]] }];
  a.loudnessTargets = [{ name: "console", integrated: -24, tolerance: 2, truePeak: -1 }, { name: "web", integrated: -16, tolerance: 1, truePeak: -2 }];
  a.loudnessResetOnPlay = false;
  return a;
}

const duck = { target: "SFX", trigger: "UI", mode: "level" as const, detector: "peak" as const, threshold: -40, amount: 0.2, attack: 0.2, release: 1 };
const auto = { bus: "Music", parameter: "Intensity", target: "lowpass" as const, curve: [[0, 24000], [1, 500, "easeIn"]] as const };
const tgt = { name: "radio", integrated: -23, tolerance: 1, truePeak: -2 };

/** Every op kind (and each variant that changes its class), with the class it has against `base()`. */
const CASES: [string, MixOp, OpClass][] = [
  ["setBus volume", { op: "setBus", bus: "Music", key: "volume", value: 0.7 }, "direct"],
  ["setBus mute", { op: "setBus", bus: "Music", key: "mute", value: true }, "direct"],
  ["setBus maxVoices set", { op: "setBus", bus: "SFX", key: "maxVoices", value: 12 }, "direct"],
  ["setBus maxVoices null", { op: "setBus", bus: "Stems", key: "maxVoices", value: null }, "direct"],
  ["setBus bed set", { op: "setBus", bus: "SFX", key: "bed", value: "none" }, "config"],
  ["setBus bed null", { op: "setBus", bus: "Stems", key: "bed", value: null }, "config"],
  ["setBus bedPriority set", { op: "setBus", bus: "SFX", key: "bedPriority", value: 10 }, "config"],
  ["setBus bedPriority null", { op: "setBus", bus: "Stems", key: "bedPriority", value: null }, "config"],
  ["setBus meter on", { op: "setBus", bus: "SFX", key: "meter", value: "loudness" }, "direct"],
  ["setBus meter off", { op: "setBus", bus: "Voice", key: "meter", value: null }, "direct"],
  ["addBus at the end", { op: "addBus", name: "Ambience", parent: "SFX" }, "direct"],
  ["addBus at an index", { op: "addBus", name: "Foley", parent: "Stems", index: 2 }, "direct"],
  ["addBus under an unknown parent", { op: "addBus", name: "Loose", parent: "Nope" }, "direct"],
  ["removeBus with descendants and references", { op: "removeBus", bus: "Music" }, "dip"],
  ["removeBus of a leaf", { op: "removeBus", bus: "UI" }, "dip"],
  ["renameBus", { op: "renameBus", from: "Stems", to: "Layers" }, "config"],
  ["moveBus", { op: "moveBus", bus: "Stems", parent: "SFX" }, "dip"],
  ["addEffect at the end", { op: "addEffect", bus: "Music", index: 2, effect: { type: "highpass", frequency: 80, q: 0.7 } }, "direct"],
  ["addEffect before the end", { op: "addEffect", bus: "Music", index: 0, effect: { type: "reverb", send: 0.1 } }, "dip"],
  ["removeEffect", { op: "removeEffect", bus: "Music", index: 0 }, "dip"],
  ["moveEffect", { op: "moveEffect", bus: "Music", from: 1, to: 0 }, "dip"],
  ["setEffect on a filter", { op: "setEffect", bus: "Music", index: 0, key: "frequency", value: 4000 }, "direct"],
  ["setEffect on a compressor", { op: "setEffect", bus: "Music", index: 1, key: "ratio", value: 8 }, "smoothed"],
  ["setEffect on a send", { op: "setEffect", bus: "Stems", index: 0, key: "send", value: 0.6 }, "direct"],
  ["addSnapshot named", { op: "addSnapshot", index: 1, name: "Combat" }, "direct"],
  ["addSnapshot unnamed", { op: "addSnapshot", index: 2 }, "direct"],
  ["removeSnapshot", { op: "removeSnapshot", index: 0 }, "direct"],
  ["renameSnapshot", { op: "renameSnapshot", index: 1, name: "Title" }, "direct"],
  ["setSnapshot volume", { op: "setSnapshot", index: 0, bus: "SFX", key: "volume", value: 0.1 }, "direct"],
  ["setSnapshot lowpass null", { op: "setSnapshot", index: 0, bus: "Stems", key: "lowpass", value: null }, "direct"],
  ["setDucking insert", { op: "setDucking", index: 1, rule: duck, insert: true }, "direct"],
  ["setDucking replace", { op: "setDucking", index: 0, rule: duck }, "direct"],
  ["setDucking remove", { op: "setDucking", index: 1, rule: null }, "direct"],
  ["setAutomation insert", { op: "setAutomation", index: 0, rule: auto, insert: true }, "direct"],
  ["setAutomation replace", { op: "setAutomation", index: 0, rule: auto }, "direct"],
  ["setAutomation remove", { op: "setAutomation", index: 0, rule: null }, "direct"],
  ["setTarget insert", { op: "setTarget", index: 2, target: tgt, insert: true }, "direct"],
  ["setTarget replace", { op: "setTarget", index: 1, target: tgt }, "direct"],
  ["setTarget remove", { op: "setTarget", index: 1, target: null }, "direct"],
  ["setOption", { op: "setOption", key: "loudnessResetOnPlay", value: true }, "config"],
];

const apply = (a: AudioSettings, ops: readonly MixOp[]) => ops.reduce(applyOpToSettings, a);

/** An interning table for the byte form. */
function table(): MixOpNameTable & { name(id: number): string; bus(ref: number): string } {
  const names: string[] = [], buses: string[] = [];
  const intern = (list: string[], s: string) => { const i = list.indexOf(s); return i >= 0 ? i : list.push(s) - 1; };
  return {
    nameId: (s) => intern(names, s), busRef: (s) => (intern(buses, s) << 8) | 7,
    name: (id) => names[id], bus: (ref) => buses[ref >>> 8],
  };
}

describe("every op kind (Mo1, §6.2)", () => {
  it("covers every op name", () => {
    expect(new Set(CASES.map(([, op]) => op.op))).toEqual(new Set(MIX_OP_NAMES));
  });
  it.each(CASES)("%s: applies, has its class, inverts, diffs back, and round-trips its byte form", (_label, op, cls) => {
    const a = base();
    expect(opRefusal(a, op)).toBeNull();
    const b = applyOpToSettings(a, op);
    expect(b).not.toBe(a);
    expect(opClass(op, a)).toBe(cls);
    expect(apply(b, invert(op, a))).toEqual(a);
    expect(apply(a, diffOps(a, b).ops)).toEqual(b);
    expect(apply(b, diffOps(b, a).ops)).toEqual(a);
    const t = table();
    const bytes = encodeMixOp(op, cls, t);
    expect(bytes.op).toBe(MIX_OP_NAMES.indexOf(op.op));
    expect(decodeMixOp({ ...bytes, words: Uint32Array.from(bytes.words) }, t)).toEqual({ op, class: cls });
  });
  it("a refused or no-op op is class none and inverts to nothing", () => {
    const a = base();
    for (const op of [
      { op: "setBus", bus: "Music", key: "volume", value: 1 },
      { op: "setBus", bus: "Nope", key: "volume", value: 0.5 },
      { op: "moveBus", bus: "Stems", parent: "Music" },
      { op: "renameBus", from: "Music", to: "Music" },
    ] as MixOp[]) {
      expect(applyOpToSettings(a, op)).toBe(a);
      expect(opClass(op, a)).toBe("none");
      expect(invert(op, a)).toEqual([]);
    }
  });
});

describe("refusals: what the parse would drop (§2.1, §2.2)", () => {
  it("refuses the root's meter and a ninth metered bus", () => {
    const a = base();
    expect(opRefusal(a, { op: "setBus", bus: "Master", key: "meter", value: "loudness" })).toBe("Master is always metered");
    for (let i = 0; i < MAX_LOUDNESS_BUSES; i++) a.buses.push({ name: `M${i}`, parent: "Master", volume: 1, mute: false, effects: [], ...(i < 6 ? { meter: "loudness" as const } : {}) });
    expect(a.buses.filter((b) => b.meter).length).toBe(MAX_LOUDNESS_BUSES);
    expect(opRefusal(a, { op: "setBus", bus: "M7", key: "meter", value: "loudness" })).toBe("At most 8 buses can be metered");
    expect(opRefusal(a, { op: "setBus", bus: "Voice", key: "meter", value: "loudness" })).toBeNull();
  });
  it("refuses removing the root, a loop, a self-duck, a duplicate name and the last target", () => {
    const a = base();
    expect(opRefusal(a, { op: "removeBus", bus: "Master" })).toMatch(/root/);
    expect(opRefusal(a, { op: "moveBus", bus: "Music", parent: "Stems" })).toMatch(/under it/);
    expect(opRefusal(a, { op: "setDucking", index: 0, rule: { ...duck, trigger: "SFX" } })).toBe("A bus can't duck itself.");
    expect(opRefusal(a, { op: "addBus", name: " SFX ", parent: "Master" })).toMatch(/already named/);
    expect(opRefusal(a, { op: "renameSnapshot", index: 1, name: "Paused" })).toMatch(/already named/);
    expect(opRefusal(a, { op: "setTarget", index: 0, target: { ...tgt, name: "web" } })).toMatch(/already named/);
    expect(opRefusal(a, { op: "setTarget", index: 0, target: { ...tgt, integrated: 3 } })).toMatch(/-70\.\.0/);
    const one = applyOpToSettings(a, { op: "setTarget", index: 1, target: null });
    expect(opRefusal(one, { op: "setTarget", index: 0, target: null })).toMatch(/At least one/);
  });
  it("writes targets equal to the defaults as absent, and resetOnPlay true as absent", () => {
    const a = defaultAudioSettings();
    const b = applyOpToSettings(a, { op: "setTarget", index: 1, target: null });
    expect(b.loudnessTargets).toEqual([{ name: "console", integrated: -24, tolerance: 2, truePeak: -1 }]);
    expect("loudnessTargets" in applyOpToSettings(b, invert({ op: "setTarget", index: 1, target: null }, a)[0])).toBe(false);
    const off = applyOpToSettings(a, { op: "setOption", key: "loudnessResetOnPlay", value: false });
    expect(off.loudnessResetOnPlay).toBe(false);
    expect("loudnessResetOnPlay" in applyOpToSettings(off, { op: "setOption", key: "loudnessResetOnPlay", value: true })).toBe(false);
  });
});

describe("applyOpToDraft", () => {
  it("writes the live keys over the authored section and keeps the rest as authored", () => {
    const d = { audio: { voices: { mixed: 64 }, background: "pause", custom: 1 } };
    const next = applyOpToDraft(d, { op: "setBus", bus: "Music", key: "volume", value: 0.5 });
    const audio = next.audio as Record<string, unknown>;
    expect(audio.voices).toEqual({ mixed: 64 });
    expect(audio.custom).toBe(1);
    expect((audio.buses as { name: string; volume: number }[]).find((b) => b.name === "Music")!.volume).toBe(0.5);
    expect("loudnessTargets" in audio).toBe(false);
  });
  it("returns the draft itself when the op is refused or changes nothing", () => {
    const d = { audio: undefined };
    expect(applyOpToDraft(d, { op: "removeBus", bus: "Master" })).toBe(d);
    expect(applyOpToDraft(d, { op: "setBus", bus: "Music", key: "volume", value: 1 })).toBe(d);
  });
});

describe("diffOps across several edits", () => {
  it("lands on b through a root rename, a reordered list, swapped names and restart-only keys", () => {
    const a = base();
    const b = base();
    b.buses[0].name = "Main";
    for (const bus of b.buses) if (bus.parent === "Master") bus.parent = "Main";
    [b.buses[1], b.buses[3]] = [b.buses[3], b.buses[1]];
    [b.snapshots[0].name, b.snapshots[1].name] = [b.snapshots[1].name, b.snapshots[0].name];
    [b.loudnessTargets![0].name, b.loudnessTargets![1].name] = [b.loudnessTargets![1].name, b.loudnessTargets![0].name];
    b.voices = { ...b.voices, mixed: 64 };
    b.rhythmMode = true;
    const { ops, restartRequired } = diffOps(a, b);
    expect(restartRequired.sort()).toEqual(["rhythmMode", "voices"]);
    expect(apply(a, ops)).toEqual({ ...b, voices: a.voices, rhythmMode: a.rhythmMode });
    expect(ops.some((o) => o.op === "renameBus")).toBe(true);
    expect(diffOps(a, base())).toEqual({ ops: [], restartRequired: [] });
  });
});
