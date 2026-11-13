// ADR 0171 amended by 0172 (M5a, Bb1; api-and-models §9 "Profiler and capture" and "CPU", §5.5, §5.6): the Babylon fallback's
// capture rows against the mocked AudioV2 engine. Events are recorded main-side (a voice's start, stop and steal, the
// mixer's setters, master and hidden-tab changes) with `busRef`s, keyframes are read from main's tables and round-trip
// through the keyframe codec, `mixCaps.capture` is "mainSideOnly", and `cpu` is null with the design's reason. No wall-clock
// assertion: the mixer's clock is advanced with `mixer.update(dt)` and async work by awaiting the mock's promises.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { babylonMock, makeFakeContext } from "../testing/babylonMocks";
import { setAudioBackend, type PlayRequest } from "./backend";
import { BabylonBackend } from "./babylonBackend";
import { decodeKeyframe, encodeKeyframe, keyframeBytes, KEYFRAME_BUS_LANES } from "./capture/format";
import { NULL_PROFILE_SINK } from "./mix/profileSink";
import { recordingSink } from "./mix/recordingSink";
import { taps } from "./mix/profileTaps";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

const BUSES = [
  { name: "Master" },
  { name: "SFX", parent: "Master", maxVoices: 2 },
  { name: "Music", parent: "Master" },
  { name: "Voice", parent: "SFX" },
];
// Slots: the mixer numbers the buses in list order.
const SLOT = { Master: 0, SFX: 1, Music: 2, Voice: 3 } as const;

function configure(): void {
  mixer.configure(parseAudioSettings({ buses: BUSES, snapshots: [{ name: "Quiet", volumes: { Music: 0.5 } }] }).settings);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

const req = (extra: Partial<PlayRequest> = {}): PlayRequest => ({ path: "a.wav", url: "asset://a.wav", loop: false, stream: false, bus: "SFX", ...extra });
const made: BabylonBackend[] = [];

function newBackend(visibility: unknown = null): BabylonBackend {
  const b = new BabylonBackend({
    createContext: () => makeFakeContext("running") as unknown as AudioContext,
    unlockTarget: new EventTarget(),
    hostContext: () => null,
    visibility: visibility as never,
  });
  made.push(b);
  setAudioBackend(b);
  mixer.onChange(() => b.applyMix(mixer.resolveAll()));
  return b;
}

beforeEach(() => {
  babylonMock.reset();
  configure();
});
afterEach(() => {
  setAudioBackend(null);
  for (const b of made.splice(0)) b.dispose();
  mixer._setTap(null);
  taps.sink = NULL_PROFILE_SINK;
  vi.restoreAllMocks();
});

describe("BabylonBackend events, main-side (§9 Profiler and capture, §5.6)", () => {
  it("a play reaches the sink as voiceStart with the voice's id, clip, the bus's busRef and its gain", async () => {
    const b = newBackend();
    const rec = recordingSink();
    b.setProfileSink(rec.sink);
    const v = b.play(req({ bus: "Music", volume: 0.5 }))!;
    await flush();
    expect(rec.of("voiceStart")).toEqual([[v.id, "a.wav", SLOT.Music, 0, 0, 0.5]]);
  });

  it("a voice that ends, one that is stopped, one faded out and one whose load fails stop with their reasons", async () => {
    const b = newBackend();
    const rec = recordingSink();
    b.setProfileSink(rec.sink);
    const ended = b.play(req())!;
    const stopped = b.play(req({ bus: "Music" }))!;
    const faded = b.play(req({ bus: "Music" }))!;
    babylonMock.failUrls.add("asset://bad.wav");
    const failed = b.play(req({ path: "bad.wav", url: "asset://bad.wav", bus: "Music" }))!;
    await flush();
    babylonMock.sounds[0]!.finish(); // the clip reaches its end
    stopped.stop();
    faded.stop(0.5);
    await flush();
    expect(rec.of("voiceStop")).toEqual(expect.arrayContaining([[ended.id, "ended"], [stopped.id, "stopped"], [faded.id, "faded"], [failed.id, "failed"]]));
    expect(rec.of("voiceStop")).toHaveLength(4);
  });

  it("a bus over its maxVoices reports voiceSteal (victim, thief, busMaxVoices) in place of a voiceStop for the victim", async () => {
    const b = newBackend();
    const rec = recordingSink();
    b.setProfileSink(rec.sink);
    const first = b.play(req())!;
    const second = b.play(req())!;
    await flush();
    const third = b.play(req())!;
    await flush();
    expect(rec.of("voiceSteal")).toEqual([[first.id, third.id, "busMaxVoices"]]);
    expect(rec.of("voiceStop").some((c) => c[0] === first.id)).toBe(false);
    expect(first.playing).toBe(false);
    expect(second.playing).toBe(true);
  });

  it("the mixer's setters report bus ramps with busRefs, a snapshot and a monitor change", async () => {
    const b = newBackend();
    const rec = recordingSink();
    b.setProfileSink(rec.sink);
    mixer.bus("Music").volume = 0.5;
    mixer.snapshot("Quiet", 1);
    mixer.setMonitor("SFX", { mute: true });
    expect(rec.of("busRamp").some((c) => c[0] === SLOT.Music && c[1] === "runtime" && c[3] === 0.5)).toBe(true);
    expect(rec.of("busRamp").some((c) => c[0] === SLOT.Music && c[1] === "snapshot" && c[3] === 0.5)).toBe(true);
    expect(rec.of("snapshot")).toEqual([["Quiet", 1]]);
    expect(rec.of("monitor")).toEqual([[1 << SLOT.SFX]]);
  });

  it("master volume and mute, and a hidden page, report masterChange and hiddenTab", async () => {
    const visibility = Object.assign(new EventTarget(), { hidden: false });
    const b = newBackend(visibility);
    b.setBackground("mute");
    const rec = recordingSink();
    b.setProfileSink(rec.sink);
    b.masterVolume = 0.25;
    b.muted = true;
    visibility.hidden = true;
    visibility.dispatchEvent(new Event("visibilitychange"));
    visibility.hidden = false;
    visibility.dispatchEvent(new Event("visibilitychange"));
    expect(rec.of("masterChange")).toEqual([[0.25, false], [0.25, true]]);
    expect(rec.of("hiddenTab")).toEqual([[true], [false]]);
  });

  it("the page-wide taps (events, music) point at the sink, and null puts every null object back", () => {
    const b = newBackend();
    const rec = recordingSink();
    b.setProfileSink(rec.sink);
    expect(taps.sink).toBe(rec.sink);
    b.setProfileSink(null);
    expect(taps.sink).toBe(NULL_PROFILE_SINK);
    expect(b._profile).toBe(NULL_PROFILE_SINK);
    rec.clear();
    mixer.bus("Music").volume = 0.7;
    b.masterVolume = 0.5;
    expect(rec.calls).toEqual([]);
  });

  it("a disposed backend leaves the taps at the null object", () => {
    const b = newBackend();
    b.setProfileSink(recordingSink().sink);
    b.dispose();
    expect(taps.sink).toBe(NULL_PROFILE_SINK);
  });

  it("a bus added after a removal gets a slot no other bus holds", async () => {
    const b = newBackend();
    b.play(req());
    await flush();
    mixer.apply({ op: "removeBus", bus: "SFX" });
    mixer.apply({ op: "addBus", name: "Amb", parent: "Master" });
    await flush();
    const slots = mixer.busNames.map((n) => b._busRef(n));
    expect(new Set(slots).size).toBe(slots.length);
  });
});

describe("BabylonBackend keyframes from main's tables (§9, §5.5)", () => {
  const ids = new Map<string, number>();
  const nameId = (table: string, name: string): number => {
    const key = `${table}:${name}`;
    if (!ids.has(key)) ids.set(key, ids.size + 1);
    return ids.get(key)!;
  };
  beforeEach(() => ids.clear());

  function roundTrip(b: BabylonBackend): ReturnType<typeof decodeKeyframe> {
    const p = b.keyframe(nameId);
    const len = keyframeBytes(p);
    const view = new DataView(new ArrayBuffer(len));
    expect(encodeKeyframe(view, 0, p)).toBe(len);
    return decodeKeyframe(view, 0, len);
  }

  it("lists the live voices, every bus's lanes, the events with voices and the mix, and encodes and decodes them", async () => {
    const b = newBackend();
    b.masterVolume = 0.5;
    b.play(req({ bus: "SFX", volume: 0.5, pitch: 2 }));
    b.play(req({ bus: "Music", path: "m.wav", url: "asset://m.wav", group: 7 }));
    await flush();
    mixer.bus("Music").mute = true;
    mixer.setMonitor("SFX", { solo: true });
    mixer.snapshot("Quiet", 0);
    mixer.update(0.1);
    const k = roundTrip(b);

    expect(k.voices).toHaveLength(2);
    const sfx = k.voices.find((v) => v.clip === nameId("clips", "a.wav"))!;
    expect(sfx).toMatchObject({ slot: SLOT.SFX, state: 0, gain: 0.5, pitch: 2 * 4096, audibility: 0xffff });
    expect(k.voices.find((v) => v.clip === nameId("clips", "m.wav"))!.slot).toBe(SLOT.Music);
    expect(k.buses.map((x) => x.slot)).toEqual([0, 1, 2, 3]);
    const music = k.buses[SLOT.Music]!;
    expect(music.flags & 2).toBe(2); // runtime mute
    expect(music.lanes).toHaveLength(KEYFRAME_BUS_LANES);
    expect(music.lanes[4]).toBeCloseTo(0.5, 6); // snapshot lane value (after the 0 s snapshot's minimum ramp)
    expect(music.lanes[5]).toBeCloseTo(0.5, 6); // and its target
    expect(k.buses[SLOT.SFX]!.flags & 8).toBe(8); // monitor solo
    expect(k.events).toEqual([{ id: 7, asset: 0xffffffff, voices: 1, state: 0, paramsHash: 0 }]);
    expect(k.metered).toEqual([]);
    expect(k.music).toEqual([]);
    expect(k.mix).toMatchObject({ monitorActive: 1, masterVolume: 0.5, hiddenMute: 0, snapshotName: nameId("snapshots", "Quiet") });
  });

  it("an empty fallback encodes: no voices, the buses at their authored values, no snapshot", () => {
    const k = roundTrip(newBackend());
    expect(k.voices).toEqual([]);
    expect(k.buses).toHaveLength(4);
    expect(k.buses[0]!.lanes.slice(0, 2)).toEqual([1, 1]);
    expect(k.mix).toMatchObject({ monitorActive: 0, snapshotName: 0xffffffff, masterVolume: 1 });
  });

  it("a removed bus drops out of the keyframe, and another bus's fade continues across the removal", async () => {
    const b = newBackend();
    b.play(req({ bus: "Voice" }));
    await flush();
    mixer.bus("Music").fadeTo(0.2, 2);
    mixer.update(0.5);
    const before = b.keyframe(nameId).buses[SLOT.Music]!;
    mixer.apply({ op: "removeBus", bus: "SFX" });
    await flush();
    const k = roundTrip(b);
    expect(k.buses.map((x) => x.slot)).toEqual([0, 2]);
    const after = k.buses.find((x) => x.slot === SLOT.Music)!;
    // The runtime lane (indices 2 and 3: value, target) is the same ramp: not snapped to its end, target unchanged.
    expect(after.lanes[3]).toBeCloseTo(0.2, 6);
    expect(after.lanes[2]).toBeCloseTo(before.lanes[2]!, 6);
    expect(after.lanes[2]).toBeGreaterThan(0.2);
    mixer.update(2);
    expect(b.keyframe(nameId).buses.find((x) => x.slot === SLOT.Music)!.lanes[2]).toBeCloseTo(0.2, 6);
  });
});

describe("BabylonBackend mixCaps and CPU on the fallback (§9 CPU)", () => {
  it("captures main-side only", () => {
    expect(newBackend().mixCaps.capture).toBe("mainSideOnly");
    expect(newBackend().debug().mixCaps.capture).toBe("mainSideOnly");
  });

  it("Audio.debug().cpu has no load figure and says why", () => {
    const cpu = newBackend().debug().cpu!;
    expect(cpu.loadPermille).toBeNull();
    expect(cpu.hidden).toBe("Babylon fallback has no audio core");
  });
});

