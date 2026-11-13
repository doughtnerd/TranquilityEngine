// ADR 0171 M5c Bb3: the Babylon fallback's live-mix rows (api-and-models §9, against the mocked AudioV2 engine). Direct ops
// set bus volumes and mutes; presence ducking runs on main; a level rule answers "Needs the audio core" and does nothing;
// a structural op rebuilds the bus graph and lands on the end state; the debug rows read what §9 says. No wall-clock
// assertion: the mixer's heard clock is advanced with `mixer.update(dt)`, and async work by awaiting the mock's promises.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import type { MixOp } from "../../../engine/audio/mixOps";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { babylonMock, makeFakeContext, type MockBus, type MockEngine } from "../testing/babylonMocks";
import { setAudioBackend, type PlayRequest } from "./backend";
import { BabylonBackend, NEEDS_AUDIO_CORE } from "./babylonBackend";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

const BUSES = [
  { name: "Master" },
  { name: "SFX", parent: "Master", maxVoices: 2, effects: [{ type: "lowpass", frequency: 4000 }, { type: "highpass", frequency: 80 }] },
  { name: "Music", parent: "Master" },
  { name: "Voice", parent: "SFX" },
];
const DUCKING = [{ trigger: "SFX", target: "Music", mode: "presence", amount: 0.4, attack: 0.1, release: 0.1 }];

function configure(extra: Record<string, unknown> = {}): void {
  mixer.configure(parseAudioSettings({ buses: BUSES, ducking: DUCKING, ...extra }).settings);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

const req = (extra: Partial<PlayRequest> = {}): PlayRequest => ({ path: "a.wav", url: "asset://a.wav", loop: false, stream: false, bus: "SFX", ...extra });
const engine = (): MockEngine => babylonMock.engine;
/** The buses the engine holds now: created and not disposed. */
const liveBuses = (): MockBus[] => engine().buses.filter((b) => !b.disposed);
const bus = (name: string): MockBus => liveBuses().find((b) => b.name === name)!;
const parentOf = (name: string): string | null => bus(name).outBus?.name ?? null;
const names = (): string[] => liveBuses().map((b) => b.name).sort();

const made: BabylonBackend[] = [];

function newBackend(): BabylonBackend {
  const b = new BabylonBackend({
    createContext: () => makeFakeContext("running") as unknown as AudioContext,
    unlockTarget: new EventTarget(),
    hostContext: () => null,
    visibility: null,
  });
  made.push(b);
  setAudioBackend(b); // `mixer.apply(op)` reaches the backend's `applyOp`
  mixer.onChange(() => b.applyMix(mixer.resolveAll()));
  return b;
}

/** A backend whose engine exists (a first play creates it and the buses). */
async function rig(): Promise<BabylonBackend> {
  const b = newBackend();
  b.play(req({ bus: "Voice" }));
  await flush();
  return b;
}

beforeEach(() => {
  babylonMock.reset();
  configure();
});
afterEach(() => {
  setAudioBackend(null);
  for (const b of made.splice(0)) b.dispose();
  vi.restoreAllMocks();
});

describe("BabylonBackend direct ops (§9 Live mixing)", () => {
  it("sets a bus volume through mixer.apply and answers class direct", async () => {
    await rig();
    expect(mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 })).toEqual({ ok: true, class: "direct" });
    mixer.update(0.1); // the authored lane's ramp is far shorter than this
    expect(bus("Music").volume).toBeCloseTo(0.5);
    expect(mixer.audioSettings.buses.find((b) => b.name === "Music")!.volume).toBe(0.5);
  });

  it("mutes and unmutes a bus", async () => {
    await rig();
    expect(mixer.apply({ op: "setBus", bus: "Music", key: "mute", value: true })).toEqual({ ok: true, class: "direct" });
    expect(bus("Music").volume).toBe(0);
    expect(mixer.apply({ op: "setBus", bus: "Music", key: "mute", value: false }).ok).toBe(true);
    expect(bus("Music").volume).toBeCloseTo(1);
  });

  it("does not rebuild the graph for a volume edit", async () => {
    await rig();
    const created = engine().buses.length;
    mixer.apply({ op: "setBus", bus: "SFX", key: "volume", value: 0.7 });
    mixer.update(0.1);
    expect(engine().buses.length).toBe(created);
    expect(engine().buses.some((b) => b.disposed)).toBe(false);
    expect(bus("SFX").volume).toBeCloseTo(0.7);
  });

  it("applies maxVoices at once: the next play stops the oldest voice over the new cap", async () => {
    const b = await rig();
    b.play(req());
    b.play(req());
    await flush();
    const sfx = () => b.debug().buses.find((x) => x.name === "SFX")!;
    expect(sfx()).toMatchObject({ voices: 2, maxVoices: 2 });
    expect(mixer.apply({ op: "setBus", bus: "SFX", key: "maxVoices", value: 1 })).toEqual({ ok: true, class: "direct" });
    b.play(req());
    await flush();
    expect(sfx()).toMatchObject({ voices: 1, maxVoices: 1 });
  });

  it.each<[string, MixOp]>([
    ["a filter parameter", { op: "setEffect", bus: "SFX", index: 0, key: "frequency", value: 2000 }],
    ["an effect appended", { op: "addEffect", bus: "Music", index: 0, effect: { type: "lowpass", frequency: 1000, q: 1 } }],
    ["a snapshot", { op: "addSnapshot", index: 0, name: "Quiet" }],
    ["a presence ducking rule", { op: "setDucking", index: 1, insert: true, rule: { trigger: "Voice", target: "Music", mode: "presence", amount: 0.5, attack: 0.1, release: 0.1 } }],
    ["a metered bus", { op: "setBus", bus: "Music", key: "meter", value: "loudness" }],
  ])("%s changes the model, answers direct and leaves the graph alone", async (_label, op) => {
    await rig();
    const created = engine().buses.length;
    expect(mixer.apply(op)).toEqual({ ok: true, class: "direct" });
    expect(engine().buses.length).toBe(created);
  });

  it("a compressor parameter answers smoothed and a bed edit answers config", async () => {
    configure({ buses: [BUSES[0], { name: "SFX", parent: "Master", effects: [{ type: "compressor" }] }, BUSES[2], BUSES[3]] });
    await rig();
    expect(mixer.apply({ op: "setEffect", bus: "SFX", index: 0, key: "ratio", value: 6 }).class).toBe("smoothed");
    expect(mixer.apply({ op: "setBus", bus: "Music", key: "bedPriority", value: 3 })).toEqual({ ok: true, class: "config" });
  });

  it("refuses a bad op with ok false, and a re-applied value is ok with class none", async () => {
    await rig();
    expect(mixer.apply({ op: "setBus", bus: "Nope", key: "volume", value: 0.5 })).toEqual({ ok: false, class: "none" });
    mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 });
    expect(mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 })).toEqual({ ok: true, class: "none" });
  });

  it("flushNow does nothing and does not throw (no batch is staged)", async () => {
    const b = await rig();
    expect(() => b.flushNow()).not.toThrow();
  });

  it("applies an op before the first play (no engine yet) and creates nothing", () => {
    newBackend();
    expect(mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 })).toEqual({ ok: true, class: "direct" });
    expect(babylonMock.creates).toBe(0);
  });
});

describe("BabylonBackend presence ducking through main (§9 Ducking)", () => {
  it("a presence rule added live ducks its target while the trigger plays", async () => {
    const b = await rig();
    mixer.apply({ op: "setDucking", index: 0, rule: null });
    b.play(req({ bus: "SFX" }));
    await flush();
    mixer.update(1);
    expect(bus("Music").volume).toBeCloseTo(1);
    expect(mixer.apply({ op: "setDucking", index: 0, insert: true, rule: { trigger: "SFX", target: "Music", mode: "presence", amount: 0.4, attack: 0.1, release: 0.1 } })).toEqual({ ok: true, class: "direct" });
    mixer.update(1);
    expect(bus("Music").volume).toBeCloseTo(0.4);
    expect(mixer.bus("Music").duckGain).toBeCloseTo(0.4);
  });

  it("the configured presence rule still ducks after unrelated live edits", async () => {
    const b = await rig();
    mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 });
    b.play(req({ bus: "SFX" }));
    await flush();
    mixer.update(1);
    expect(bus("Music").volume).toBeCloseTo(0.5 * 0.4);
  });
});

describe("BabylonBackend level ducking rules (§9 Ducking)", () => {
  const level: MixOp = { op: "setDucking", index: 1, insert: true, rule: { trigger: "SFX", target: "Music", mode: "level", detector: "rms", threshold: -30, amount: 0.3, attack: 0.1, release: 0.1 } };

  it("answers as needing the audio core, with the design's message", async () => {
    await rig();
    expect(NEEDS_AUDIO_CORE).toBe("Needs the audio core");
    expect(mixer.apply(level)).toEqual({ ok: false, class: "direct", restartRequired: "Needs the audio core" });
  });

  it("does nothing: the level rule never ducks, while a presence rule beside it still does", async () => {
    const b = await rig();
    mixer.apply({ op: "setDucking", index: 0, rule: null });
    mixer.apply({ op: "setDucking", index: 0, insert: true, rule: { trigger: "SFX", target: "Voice", mode: "level", detector: "rms", threshold: -30, amount: 0.3, attack: 0.1, release: 0.1 } });
    b.play(req({ bus: "SFX" }));
    await flush();
    mixer.update(2);
    expect(bus("Voice").volume).toBeCloseTo(1);
    expect(mixer.bus("Voice").duckGain).toBe(1);
    mixer.apply({ op: "setDucking", index: 1, insert: true, rule: { trigger: "SFX", target: "Music", mode: "presence", amount: 0.4, attack: 0.1, release: 0.1 } });
    mixer.update(1);
    expect(bus("Music").volume).toBeCloseTo(0.4);
  });

  it("editing a presence rule into level mode stops its ducking and answers the same", async () => {
    const b = await rig();
    b.play(req({ bus: "SFX" }));
    await flush();
    mixer.update(1);
    expect(bus("Music").volume).toBeCloseTo(0.4);
    const r = mixer.apply({ op: "setDucking", index: 0, rule: { trigger: "SFX", target: "Music", mode: "level", detector: "rms", threshold: -30, amount: 0.4, attack: 0.1, release: 0.1 } });
    expect(r.restartRequired).toBe(NEEDS_AUDIO_CORE);
    mixer.update(1);
    expect(bus("Music").volume).toBeCloseTo(1);
  });

  it("removing a level rule is an ordinary edit", async () => {
    await rig();
    mixer.apply(level);
    expect(mixer.apply({ op: "setDucking", index: 1, rule: null })).toEqual({ ok: true, class: "direct" });
  });

  it("debug lists the level rule as mode level with no duck", async () => {
    const b = await rig();
    mixer.apply(level);
    const d = b.debug().mix!.ducking;
    expect(d.map((r) => r.mode)).toEqual(["presence", "level"]);
    expect(d[1]!.gain).toBe(1);
    expect(b.mixCaps.levelDucking).toBe(false);
  });
});

describe("BabylonBackend structural ops rebuild the graph (§9 Live mixing)", () => {
  const shape = (): Record<string, [string | null, number]> => {
    const s: Record<string, [string | null, number]> = {};
    for (const b of liveBuses()) s[b.name] = [b.outBus?.name ?? null, b.volume];
    return s;
  };

  it("a move reparents the bus: new nodes, the old ones disposed, voices carried over", async () => {
    await rig();
    const before = liveBuses();
    expect(mixer.apply({ op: "moveBus", bus: "Voice", parent: "Music" })).toEqual({ ok: true, class: "dip" });
    await flush();
    expect(before.every((x) => x.disposed)).toBe(true);
    expect(names()).toEqual(["Master", "Music", "SFX", "Voice"]);
    expect(parentOf("Voice")).toBe("Music");
    expect(parentOf("Music")).toBe("Master");
    expect(engine().sounds[engine().sounds.length - 1]!.outBus).toBe(bus("Voice"));
  });

  it("lands on the end state of several structural ops in a row", async () => {
    await rig();
    mixer.apply({ op: "setBus", bus: "Music", key: "volume", value: 0.5 });
    mixer.apply({ op: "addBus", name: "Ambience", parent: "Master" });
    mixer.apply({ op: "moveBus", bus: "Voice", parent: "Ambience" });
    mixer.apply({ op: "removeBus", bus: "SFX" });
    mixer.update(0.1);
    await flush();
    expect(shape()).toEqual({ Master: ["default", 1], Music: ["Master", 0.5], Ambience: ["Master", 1], Voice: ["Ambience", 1] });
    expect(mixer.audioSettings.buses.map((x) => x.name).sort()).toEqual(["Ambience", "Master", "Music", "Voice"]);
  });

  it("a removed bus's nodes go, its voices play on the root, and the mixer no longer resolves it", async () => {
    const b = await rig();
    b.play(req({ bus: "SFX" }))!;
    await flush();
    expect(mixer.apply({ op: "removeBus", bus: "SFX" })).toEqual({ ok: true, class: "dip" });
    await flush();
    expect(names()).toEqual(["Master", "Music"]);
    // the SFX voice and the Voice voice (a descendant) both moved to the root
    expect(b.debug().buses.find((x) => x.name === "Master")!.voices).toBe(2);
    expect(engine().sounds[engine().sounds.length - 1]!.outBus).toBe(bus("Master"));
    expect(mixer.resolveAll().map((x) => x.name).sort()).toEqual(["Master", "Music"]);
    expect(b.debug().buses.map((x) => x.name).sort()).toEqual(["Master", "Music"]);
  });

  it("an added bus gets a node under its parent", async () => {
    await rig();
    expect(mixer.apply({ op: "addBus", name: "Ambience", parent: "Music" })).toEqual({ ok: true, class: "direct" });
    await flush();
    expect(parentOf("Ambience")).toBe("Music");
    expect(bus("Ambience").volume).toBe(1);
  });

  it("a rename rebuilds under the new name and keeps the voices and the bus's volume", async () => {
    const b = await rig();
    mixer.apply({ op: "setBus", bus: "SFX", key: "volume", value: 0.6 });
    mixer.update(0.1);
    b.play(req({ bus: "SFX" }))!;
    await flush();
    expect(mixer.apply({ op: "renameBus", from: "SFX", to: "Effects" })).toEqual({ ok: true, class: "config" });
    await flush();
    expect(names()).toEqual(["Effects", "Master", "Music", "Voice"]);
    expect(bus("Effects").volume).toBeCloseTo(0.6);
    expect(parentOf("Voice")).toBe("Effects");
    expect(b.debug().buses.find((x) => x.name === "Effects")!.voices).toBe(1);
  });

  it.each<[string, MixOp]>([
    ["removeEffect", { op: "removeEffect", bus: "SFX", index: 0 }],
    ["moveEffect", { op: "moveEffect", bus: "SFX", from: 0, to: 1 }],
    ["an effect inserted before the end", { op: "addEffect", bus: "SFX", index: 0, effect: { type: "lowpass", frequency: 900, q: 1 } }],
  ])("%s answers dip, rebuilds the graph and keeps the volumes", async (_label, op) => {
    await rig();
    const before = liveBuses();
    expect(mixer.apply(op)).toEqual({ ok: true, class: "dip" });
    await flush();
    expect(before.every((x) => x.disposed)).toBe(true);
    expect(shape()).toEqual({ Master: ["default", 1], SFX: ["Master", 1], Music: ["Master", 1], Voice: ["SFX", 1] });
  });

  it("a rebuilt bus still takes volume edits on the engine's short ramp", async () => {
    await rig();
    expect(engine().options).toMatchObject({ parameterRampDuration: 0.015 });
    mixer.apply({ op: "moveBus", bus: "Voice", parent: "Music" });
    await flush();
    mixer.apply({ op: "setBus", bus: "Voice", key: "volume", value: 0.5 });
    mixer.update(0.1);
    expect(bus("Voice").volume).toBeCloseTo(0.5);
  });
});

describe("BabylonBackend debug and panel rows (§9)", () => {
  it("reports the capabilities that say what the fallback lacks, and no CPU figure", async () => {
    const d = (await rig()).debug();
    expect(d.mixCaps).toEqual({ loudness: false, levelDucking: false, cpu: false, cpuReason: "Babylon fallback has no audio core", stampedBusRamps: false, capture: "mainSideOnly" });
    expect(d.cpu).toMatchObject({ loadPermille: null, hidden: "Babylon fallback has no audio core" });
  });

  it("loudness stays inert after a live edit that meters a bus", async () => {
    await rig();
    mixer.apply({ op: "setBus", bus: "Music", key: "meter", value: "loudness" });
    const l = mixer.bus("Music").loudness;
    expect(l.metered).toBe(false);
    expect(l.integrated).toBe(Number.NEGATIVE_INFINITY);
  });

  it("the mix section counts no refused or deferred edit and its slots follow the live tree", async () => {
    const b = await rig();
    mixer.apply({ op: "addBus", name: "Ambience", parent: "Master" });
    mixer.apply({ op: "removeBus", bus: "SFX" });
    await flush();
    const mix = b.debug().mix!;
    expect(mix.liveRefused).toBe(0);
    expect(mix.liveDeferred).toBe(0);
    expect(mix.slots.map((s) => s.name).sort()).toEqual(["Ambience", "Master", "Music"]);
  });
});
