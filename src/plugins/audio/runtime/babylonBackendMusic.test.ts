// B1 (ADR 0166 M4, api-and-models §8): the Babylon fallback's `music` member against the mocked AudioV2 engine.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { babylonMock, makeFakeContext, type FakeContext, type MockSound } from "../testing/babylonMocks";
import type { MusicBackend, MusicGroupEvent, MusicGroupMember, MusicGroupRequest, PlayRequest } from "./backend";
import { BabylonBackend } from "./babylonBackend";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

const member = (stem: string, extra: Partial<MusicGroupMember> = {}, play: Partial<PlayRequest> = {}): MusicGroupMember => ({
  stem,
  play: { path: `${stem}.wav`, url: `asset://${stem}.wav`, loop: false, stream: false, bus: "Music", group: 7, ...play },
  startFrame: 0,
  loop: false,
  ...extra,
});
const request = (members: MusicGroupMember[], group = 1): MusicGroupRequest => ({ instance: 7, group, members });

let backend: BabylonBackend;
let context: FakeContext;
let music: MusicBackend;

beforeEach(() => {
  babylonMock.reset();
  mixer.configure(parseAudioSettings({ buses: [{ name: "Master" }, { name: "Music", parent: "Master" }] }).settings);
  context = makeFakeContext("running");
  backend = new BabylonBackend({ createContext: () => context as unknown as AudioContext, unlockTarget: new EventTarget(), hostContext: () => null, visibility: null });
  backend.configureBuses(mixer);
  backend.applyMix(mixer.resolveAll());
  music = backend.music!;
});
afterEach(() => {
  vi.useRealTimers();
  backend.dispose();
  vi.restoreAllMocks();
});

const sounds = (): MockSound[] => babylonMock.engine.sounds;
const setTime = (t: number): void => {
  context.currentTime = t;
  babylonMock.engine.currentTime = t;
};

describe("Babylon fallback music: capabilities and priming", () => {
  it("has a music member with the fallback's caps", () => {
    expect(music.caps).toEqual({ primes: false, stampedFades: true, heardClock: false, rhythm: false });
    expect(music.primeEmaMs).toBe(40);
  });

  it("admits a group and always answers primed", () => {
    expect(music.primedState(1)).toBeNull();
    expect(music.admitGroup(request([member("a"), member("b")]))).toEqual({ ok: true });
    expect(music.primedState(1)).toEqual({ group: 1, primed: 2, of: 2, ready: true });
  });

  it("refuses once the backend is disposed", () => {
    backend.dispose();
    expect(music.admitGroup(request([member("a")])).ok).toBe(false);
  });

  it("decodes the group's clips at admit, not the streamed ones", async () => {
    music.admitGroup(request([member("a"), member("s", {}, { stream: true })]));
    await flush();
    expect(babylonMock.engine.bufferLoads).toEqual(["asset://a.wav"]);
    expect(babylonMock.engine.streamLoads).toEqual([]);
  });

  it("primeGroup warns once that streamed stems may drift, and flat once per streamed path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = request([member("flatstream1", {}, { stream: true }), member("flatstream2", {}, { stream: true })], 2);
    music.admitGroup(req);
    music.primeGroup(req);
    music.primeGroup(req, { retarget: true });
    const text = warn.mock.calls.map((c) => String(c[0]));
    expect(text.filter((t) => t.includes("may drift"))).toHaveLength(1);
    expect(text.filter((t) => t.includes("flatstream1.wav"))).toHaveLength(1);
    expect(text.filter((t) => t.includes("flatstream2.wav"))).toHaveLength(1);
  });
});

describe("Babylon fallback music: stamped starts", () => {
  it("starts decoded stems through waitTime from Audio.time, with start offset and loop region in seconds", async () => {
    const req = request([member("a", { startFrame: 48000 }), member("b", { loop: true, loopStartFrame: 24000, loopEndFrame: 96000 })]);
    music.admitGroup(req);
    await flush();
    setTime(1);
    const voices = music.stampGroup({ group: 1, at: 3.5 });
    expect(voices).toHaveLength(2);
    await flush();
    expect(sounds()).toHaveLength(2);
    expect(sounds()[0]!.plays).toEqual([{ waitTime: 2.5, startOffset: 1 }]);
    expect(sounds()[1]!.plays).toEqual([{ waitTime: 2.5 }]);
    const looped = sounds()[1] as MockSound & { loopStart?: number; loopEnd?: number };
    expect(looped.loop).toBe(true);
    expect(looped.loopStart).toBeCloseTo(0.5);
    expect(looped.loopEnd).toBeCloseTo(2);
  });

  it("a stamp in the past plays at once", async () => {
    music.admitGroup(request([member("a")]));
    await flush();
    setTime(5);
    music.stampGroup({ group: 1, at: 4 });
    await flush();
    expect(sounds()[0]!.plays).toEqual([{}]);
  });

  it("fadeZero starts silent", async () => {
    music.admitGroup(request([member("a", { fadeZero: true })]));
    await flush();
    music.stampGroup({ group: 1, at: 0 });
    await flush();
    expect(sounds()[0]!.options.volume).toBe(0);
  });

  it("a stamp for an unknown group returns nothing", () => {
    expect(music.stampGroup({ group: 99, at: 1 })).toEqual([]);
  });

  it("streamed stems start from a timer, flat and unaligned", async () => {
    const req = request([member("s", {}, { stream: true })]);
    music.admitGroup(req);
    music.primeGroup(req);
    await flush();
    vi.useFakeTimers();
    setTime(1);
    const [v] = music.stampGroup({ group: 1, at: 1.5 });
    await vi.advanceTimersByTimeAsync(10);
    expect(sounds()[0]!.kind).toBe("streaming");
    expect(sounds()[0]!.plays).toEqual([]);
    expect(v!.fadeShaped).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(sounds()[0]!.plays).toEqual([{}]);
  });
});

describe("Babylon fallback music: fades", () => {
  it("a linear stamped fade is one setVolume ramp, started at its time", async () => {
    music.admitGroup(request([member("a")]));
    await flush();
    vi.useFakeTimers();
    setTime(0);
    const [v] = music.stampGroup({ group: 1, at: 0 });
    await vi.advanceTimersByTimeAsync(10);
    const s = sounds()[0]!;
    v!.fadeShaped!({ to: 0, seconds: 2, law: "linear", at: 1 });
    expect(s.ramps).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.ramps).toEqual([{ value: 0, duration: 2 }]);
  });

  it("an equal-power fade runs in steps and stops at the end", async () => {
    music.admitGroup(request([member("a")]));
    await flush();
    vi.useFakeTimers();
    const [v] = music.stampGroup({ group: 1, at: 0 });
    await vi.advanceTimersByTimeAsync(10);
    const s = sounds()[0]!;
    v!.fadeShaped!({ to: 0, seconds: 1, law: "equalPowerOut", stopAtEnd: true });
    expect(s.ramps.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(s.ramps.length).toBe(8);
    expect(s.ramps[0]!.value).toBeCloseTo(Math.cos(Math.PI / 16), 5);
    expect(s.ramps.at(-1)!.value).toBe(0);
    expect(v!.playing).toBe(false);
    expect(s.stops).toHaveLength(1);
  });
});

describe("Babylon fallback music: events", () => {
  it("reports start once the stamp time is reached, then end", async () => {
    music.admitGroup(request([member("a")]));
    await flush();
    const events: MusicGroupEvent[] = [];
    music.onGroupEvent = (e) => events.push(e);
    setTime(1);
    music.stampGroup({ group: 1, at: 2 });
    await flush();
    backend.update(0);
    expect(events).toEqual([]);
    setTime(2.01);
    backend.update(0);
    expect(events).toEqual([{ kind: "start", group: 1, late: false, slipFrames: 0, startFrame: 0 }]);
    sounds()[0]!.finish();
    backend.update(0);
    expect(events.at(-1)).toEqual({ kind: "end", group: 1, member: 0 });
    expect(music.primedState(1)).toBeNull();
  });

  it("reports a late start with its slip", async () => {
    music.admitGroup(request([member("a")]));
    await flush();
    const events: MusicGroupEvent[] = [];
    music.onGroupEvent = (e) => events.push(e);
    setTime(5);
    music.stampGroup({ group: 1, at: 4.5 });
    await flush();
    backend.update(0);
    expect(events).toEqual([{ kind: "start", group: 1, late: true, slipFrames: 24000, startFrame: 0 }]);
  });

  it("reports a failed member as an error", async () => {
    babylonMock.failUrls.add("asset://bad.wav");
    music.admitGroup(request([member("bad")]));
    await flush();
    const events: MusicGroupEvent[] = [];
    music.onGroupEvent = (e) => events.push(e);
    music.stampGroup({ group: 1, at: 0 });
    await flush();
    backend.update(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "error", group: 1, member: 0 });
  });

  it("cancelGroup stops the members and sends no events", async () => {
    music.admitGroup(request([member("a")]));
    await flush();
    const events: MusicGroupEvent[] = [];
    music.onGroupEvent = (e) => events.push(e);
    const [v] = music.stampGroup({ group: 1, at: 9 });
    await flush();
    music.cancelGroup(1);
    expect(v!.playing).toBe(false);
    setTime(10);
    backend.update(0);
    expect(events).toEqual([]);
    expect(music.primedState(1)).toBeNull();
    music.cancelGroup(1);
  });
});
