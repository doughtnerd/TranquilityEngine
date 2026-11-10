// BB1 L3: `BabylonBackend` against the mocked AudioV2 engine (`../testing/babylonMocks`): bus mapping, mix gains on
// bus volumes, spatial attributes, `maxVoices`, unlock and context reuse, voice counts, setters before the sound is
// ready, load failure. The last block runs the engine-level behaviours of `audioBackend.test.ts` and
// `spatialAudio.test.ts` (which use the fake backend) against this backend.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Camera, Engine, GameObject, SceneManager, Vector3 } from "../../../myco";
import { mixer } from "../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { babylonMock, makeFakeContext, type FakeContext, type MockBus, type MockEngine, type MockSound } from "../testing/babylonMocks";
import { setAudioBackend, type PlayRequest } from "./backend";
import { BabylonBackend, type BabylonBackendOptions } from "./babylonBackend";
import { Audio, AudioListener, AudioSource } from "./index";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

const BUSES = [{ name: "Master" }, { name: "SFX", parent: "Master", maxVoices: 2 }, { name: "Music", parent: "Master" }];

function configureMixer(buses: unknown[] = BUSES): void {
  mixer.configure(parseAudioSettings({ buses }).settings);
}

/** Lets pending promise callbacks (the dynamic import, the mock engine's awaits) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

const req = (extra: Partial<PlayRequest> = {}): PlayRequest => ({ path: "a.wav", url: "asset://a.wav", loop: false, stream: false, bus: "SFX", ...extra });

interface Rig {
  backend: BabylonBackend;
  context: FakeContext;
  target: EventTarget;
  createContext: ReturnType<typeof vi.fn>;
}

const live: BabylonBackend[] = [];

function rig(options: BabylonBackendOptions & { state?: string } = {}): Rig {
  const context = makeFakeContext(options.state ?? "running");
  const target = options.unlockTarget ?? new EventTarget();
  const createContext = vi.fn(() => context as unknown as AudioContext);
  const backend = new BabylonBackend({ createContext, unlockTarget: target, hostContext: () => null, ...options });
  live.push(backend);
  backend.configureBuses(mixer);
  backend.applyMix(mixer.resolveAll());
  return { backend, context, target, createContext };
}

const engine = (): MockEngine => babylonMock.engine;
const sound = (i = 0): MockSound => engine().sounds[i]!;
const bus = (name: string): MockBus => engine().buses.find((b) => b.name === name)!;

beforeEach(() => {
  babylonMock.reset();
  configureMixer();
});
afterEach(() => {
  vi.useRealTimers();
  setAudioBackend(null);
  for (const b of live.splice(0)) b.dispose();
  vi.restoreAllMocks();
});

describe("BabylonBackend engine", () => {
  it("creates nothing until the first play", async () => {
    const { backend, createContext } = rig();
    backend.setListener({ position: { x: 1, y: 2, z: 3 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } });
    backend.applyMix(mixer.resolveAll());
    await flush();
    expect(babylonMock.creates).toBe(0);
    expect(createContext).not.toHaveBeenCalled();
    expect(backend.status).toBe("running");
    expect(backend.time).toBe(0);
    backend.play(req());
    await flush();
    expect(babylonMock.creates).toBe(1);
    expect(createContext).toHaveBeenCalledTimes(1);
  });

  it("makes the engine on the shared context with Babylon's own unlock and resume off", async () => {
    const { backend, context } = rig();
    backend.play(req());
    backend.play(req());
    await flush();
    expect(babylonMock.engines).toHaveLength(1);
    expect(engine().options).toMatchObject({ audioContext: context, resumeOnInteraction: false, resumeOnPause: false, disableDefaultUI: true, parameterRampDuration: 0.015 });
  });

  it("applies master volume and mute, from before the engine existed and after", async () => {
    const { backend } = rig();
    backend.masterVolume = 0.5;
    backend.play(req());
    await flush();
    expect(engine().volume).toBe(0.5);
    backend.muted = true;
    expect(engine().volume).toBe(0);
    expect(backend.muted).toBe(true);
    backend.muted = false;
    backend.masterVolume = 0.25;
    expect(engine().volume).toBe(0.25);
    expect(backend.masterVolume).toBe(0.25);
  });

  it("takes the time from the context", async () => {
    const { backend, context } = rig();
    backend.play(req());
    await flush();
    context.currentTime = 12.5;
    expect(backend.time).toBe(12.5);
  });
});

describe("BabylonBackend context and unlock", () => {
  it("makes one context for the page and arms the unlock layer while it is suspended", async () => {
    const { backend, context, target, createContext } = rig({ state: "suspended" });
    backend.play(req());
    backend.play(req({ path: "b.wav", url: "asset://b.wav" }));
    await flush();
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(backend.status).toBe("locked");
    expect(context.resumes).toBe(0);
    target.dispatchEvent(new Event("pointerdown"));
    await flush();
    expect(context.resumes).toBe(1);
    expect(backend.status).toBe("running");
  });

  it("re-arms when the context is interrupted later", async () => {
    const { backend, context, target } = rig({ state: "running" });
    backend.play(req());
    await flush();
    context.setState("interrupted");
    expect(backend.status).toBe("locked");
    target.dispatchEvent(new Event("keydown"));
    await flush();
    expect(context.resumes).toBe(1);
    expect(backend.status).toBe("running");
  });

  it("reuses the host's context and leaves unlocking to the host", async () => {
    const host = makeFakeContext("suspended");
    const target = new EventTarget();
    const add = vi.spyOn(target, "addEventListener");
    const { backend, createContext } = rig({ hostContext: () => host as unknown as AudioContext, unlockTarget: target });
    backend.play(req());
    await flush();
    expect(createContext).not.toHaveBeenCalled();
    expect(engine().options.audioContext).toBe(host);
    expect(add).not.toHaveBeenCalled();
    expect(backend.status).toBe("locked");
    host.setState("running");
    expect(backend.status).toBe("running");
    host.currentTime = 4;
    expect(backend.time).toBe(4);
    // The host's context outlives this backend: disposing must not close it.
    backend.dispose();
    expect(engine().disposed).toBe(true);
    expect(host.closed).toBe(false);
  });

  it("stops listening for gestures once disposed", async () => {
    const { backend, context, target } = rig({ state: "suspended" });
    backend.play(req());
    await flush();
    backend.dispose();
    target.dispatchEvent(new Event("pointerdown"));
    await flush();
    expect(context.resumes).toBe(0);
    expect(engine().disposed).toBe(true);
  });

  it("closes the context it made when it is disposed before any engine exists", async () => {
    const { backend, context } = rig({ state: "running" });
    backend.play(req());
    backend.dispose();
    await flush();
    expect(babylonMock.engine.disposed).toBe(true);
    expect(context.closed).toBe(true);
  });

  it("closes the context it made when disposed after its engine exists", async () => {
    const { backend, context } = rig();
    backend.play(req());
    await flush();
    backend.dispose();
    expect(context.closed).toBe(true);
  });

  it("reports a closed context as failed", async () => {
    const { backend, context } = rig();
    backend.play(req());
    await flush();
    context.state = "closed";
    expect(backend.status).toBe("failed");
  });
});

describe("BabylonBackend buses", () => {
  it("maps the mixer's tree to AudioBuses, parents through outBus and the root to the main bus", async () => {
    const { backend } = rig();
    backend.play(req());
    await flush();
    expect(engine().buses.map((b) => b.name)).toEqual(["Master", "SFX", "Music"]);
    expect(bus("Master").outBus).toBe(engine().defaultMainBus);
    expect(bus("SFX").outBus).toBe(bus("Master"));
    expect(bus("Music").outBus).toBe(bus("Master"));
  });

  it("creates a parent that the project lists later first", async () => {
    configureMixer([{ name: "Master" }, { name: "Child", parent: "Mid" }, { name: "Mid", parent: "Master" }]);
    const { backend } = rig();
    backend.play(req({ bus: "Child" }));
    await flush();
    expect(engine().buses.map((b) => b.name)).toEqual(["Master", "Mid", "Child"]);
    expect(bus("Child").outBus).toBe(bus("Mid"));
  });

  it("starts each bus at the gain applyMix last gave it and sets bus volumes from the resolved gain", async () => {
    const { backend } = rig();
    mixer.bus("Music").volume = 0.5;
    backend.applyMix(mixer.resolveAll());
    backend.play(req());
    await flush();
    expect(bus("Music").volume).toBe(0.5);
    expect(bus("SFX").volume).toBe(1);
    mixer.bus("SFX").volume = 0.25;
    mixer.bus("Music").mute = true;
    mixer.bus("Master").volume = 0.8;
    backend.applyMix(mixer.resolveAll());
    expect(bus("SFX").volume).toBeCloseTo(0.25);
    expect(bus("Music").volume).toBe(0);
    // Each bus gets its own gain: the parent's is not multiplied in (the buses are chained).
    expect(bus("Master").volume).toBeCloseTo(0.8);
  });

  it("applies snapshot and ducking gains the mixer resolved, and skips buses whose volume didn't change", async () => {
    const { backend } = rig();
    backend.play(req());
    await flush();
    const before = bus("SFX").ramps.length;
    backend.applyMix(mixer.resolveAll());
    expect(bus("SFX").ramps.length).toBe(before);
    const resolved = mixer.resolveAll().map((b) => (b.name === "Music" ? { ...b, gain: 0.4 } : b));
    backend.applyMix(resolved);
    expect(bus("Music").volume).toBe(0.4);
  });

  it("rebuilds the buses on configureBuses and moves live voices onto the new ones", async () => {
    const { backend } = rig();
    backend.play(req({ bus: "Music" }));
    await flush();
    const oldMusic = bus("Music");
    const oldMaster = bus("Master");
    configureMixer([{ name: "Master" }, { name: "Music", parent: "Master" }, { name: "Extra", parent: "Music" }]);
    backend.configureBuses(mixer);
    backend.applyMix(mixer.resolveAll());
    await flush();
    expect(oldMusic.disposed).toBe(true);
    expect(oldMaster.disposed).toBe(true);
    const names = engine().buses.map((b) => b.name);
    expect(names).toEqual(["Master", "SFX", "Music", "Master", "Music", "Extra"]);
    const newMusic = engine().buses.at(-2)!;
    expect(sound().outBus).toBe(newMusic);
    expect(engine().buses.at(-1)!.outBus).toBe(newMusic);
  });

  it("plays on the root when the bus name is unknown", async () => {
    const { backend } = rig();
    backend.play(req({ bus: "Gone" }));
    await flush();
    expect(sound().outBus).toBe(bus("Master"));
  });

  it("reports the buses in debug", async () => {
    const { backend } = rig();
    backend.play(req());
    backend.play(req());
    await flush();
    const info = backend.debug();
    expect(info.buses.find((b) => b.name === "SFX")).toMatchObject({ voices: 2, maxVoices: 2, gain: 1 });
    expect(info.buses.find((b) => b.name === "Music")).toMatchObject({ voices: 0, maxVoices: null });
  });
});

describe("BabylonBackend sounds", () => {
  it("plays a decoded clip as a StaticSound on its bus with its volume, loop and pitch", async () => {
    const { backend } = rig();
    backend.play(req({ bus: "Music", volume: 0.5, pitch: 1.25, loop: true }));
    await flush();
    const s = sound();
    expect(s.kind).toBe("static");
    expect(s.outBus).toBe(bus("Music"));
    expect(s.options).toMatchObject({ volume: 0.5, loop: true, playbackRate: 1.25 });
    expect(s.spatialTouched).toBe(false);
    expect(s.plays).toEqual([{}]);
  });

  it("decodes each clip once, however many sounds play it, and tries again after a failure", async () => {
    const { backend } = rig();
    for (let i = 0; i < 3; i++) backend.play(req({ bus: "Music" }));
    backend.play(req({ bus: "Music", url: "asset://b.wav", path: "b.wav" }));
    await flush();
    expect(engine().bufferLoads).toEqual(["asset://a.wav", "asset://b.wav"]);
    expect(engine().sounds).toHaveLength(4);
    babylonMock.failUrls.add("asset://c.wav");
    const first = backend.play(req({ bus: "Music", url: "asset://c.wav", path: "c.wav" }))!;
    await flush();
    expect(first.reason).toBe("failed");
    babylonMock.failUrls.clear();
    const second = backend.play(req({ bus: "Music", url: "asset://c.wav", path: "c.wav" }))!;
    await flush();
    expect(second.reason).toBeNull();
    expect(engine().bufferLoads.filter((u) => u === "asset://c.wav")).toHaveLength(2);
  });

  it("plays a stream clip as a StreamingSound from its URL", async () => {
    const { backend } = rig();
    backend.play(req({ stream: true, bus: "Music", pitch: 2, loop: true }));
    await flush();
    const s = sound();
    expect(s.kind).toBe("streaming");
    expect(s.source).toBe("asset://a.wav");
    expect(s.options).toMatchObject({ loop: true });
    expect("playbackRate" in s.options).toBe(false);
    expect(engine().bufferLoads).toEqual([]);
    expect(s.plays).toHaveLength(1);
  });

  it("starts at the requested time on the audio clock when it is ahead, and at once when it is past", async () => {
    const { backend } = rig();
    backend.play(req({ bus: "Music" }));
    await flush();
    engine().currentTime = 1;
    backend.play(req({ bus: "Music", at: 3.5 }));
    backend.play(req({ bus: "Music", at: 0.5 }));
    backend.play(req({ bus: "Music", at: Number.NaN }));
    await flush();
    expect(sound(1).plays).toEqual([{ waitTime: 2.5 }]);
    expect(sound(2).plays).toEqual([{}]);
    expect(sound(3).plays).toEqual([{}]);
  });

  it("applies volume, pitch and fade to a playing sound", async () => {
    const { backend } = rig();
    const v = backend.play(req({ volume: 0.5 }))!;
    await flush();
    v.setVolume(0.8);
    expect(sound().volume).toBeCloseTo(0.8);
    v.setPitch(1.5);
    expect(sound().playbackRate).toBe(1.5);
    v.fade(0.5, 2);
    expect(sound().ramps.at(-1)).toEqual({ value: expect.closeTo(0.4), duration: 2 });
    v.fade(2, 0);
    expect(sound().volume).toBeCloseTo(1.6);
    v.setVolume(0.1);
    expect(sound().volume).toBeCloseTo(0.2);
  });

  it("pauses and resumes", async () => {
    const { backend } = rig();
    const v = backend.play(req())!;
    await flush();
    v.pause();
    v.pause();
    expect(sound().pauses).toBe(1);
    expect(v.playing).toBe(true);
    v.resume();
    v.resume();
    expect(sound().resumes).toBe(1);
  });

  it("ends the voice when the clip ends", async () => {
    const { backend } = rig();
    const v = backend.play(req())!;
    await flush();
    expect(v.playing).toBe(true);
    sound().finish();
    expect(v.playing).toBe(false);
    expect(v.reason).toBeNull();
    expect(sound().disposed).toBe(true);
    expect(backend.debug().core.voices).toBe(0);
  });

  it("stops now, or fades out and stops when the fade is over", async () => {
    const { backend } = rig();
    const a = backend.play(req())!;
    const b = backend.play(req())!;
    await flush();
    a.stop();
    expect(a.playing).toBe(false);
    expect(sound(0).stops).toHaveLength(1);
    expect(sound(0).disposed).toBe(true);
    vi.useFakeTimers();
    b.stop(0.5);
    expect(b.playing).toBe(false);
    expect(sound(1).ramps.at(-1)).toEqual({ value: 0, duration: 0.5 });
    expect(sound(1).stops).toHaveLength(0);
    vi.advanceTimersByTime(499);
    expect(sound(1).stops).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(sound(1).stops).toHaveLength(1);
    expect(sound(1).disposed).toBe(true);
  });
});

describe("BabylonBackend spatial sound", () => {
  it("makes a sound spatial from its attenuation: distance model, min, max, rolloff factor 1", async () => {
    const { backend } = rig();
    const v = backend.play(req({ attenuation: { minDistance: 2, maxDistance: 50, rolloff: "linear" }, position: { x: 4, y: 5, z: 6 } }))!;
    await flush();
    const s = sound();
    expect(s.options).toMatchObject({ spatialEnabled: true, spatialDistanceModel: "linear", spatialMinDistance: 2, spatialMaxDistance: 50, spatialRolloffFactor: 1, spatialPanningModel: "HRTF" });
    expect(s.spatial.distanceModel).toBe("linear");
    expect(s.spatial.position).toMatchObject({ x: 4, y: 5, z: 6 });
    v.setPosition({ x: -1, y: 0, z: 9 });
    expect(s.spatial.position).toMatchObject({ x: -1, y: 0, z: 9 });
    expect(s.spatial.updates).toBeGreaterThan(0);
    v.setAttenuation({ minDistance: 3, maxDistance: 30, rolloff: "exponential" });
    expect(s.spatial).toMatchObject({ distanceModel: "exponential", minDistance: 3, maxDistance: 30, rolloffFactor: 1 });
  });

  it("turns a flat sound spatial when attenuation and position arrive afterwards", async () => {
    const { backend } = rig();
    const v = backend.play(req())!;
    await flush();
    expect(sound().spatialTouched).toBe(false);
    v.setAttenuation({ minDistance: 1, maxDistance: 9, rolloff: "inverse" });
    v.setPosition({ x: 1, y: 2, z: 3 });
    expect(sound().spatialTouched).toBe(true);
    expect(sound().spatial.maxDistance).toBe(9);
    expect(sound().spatial.position).toMatchObject({ x: 1, y: 2, z: 3 });
  });

  it("uses equal-power panning when audio.spatial says so", async () => {
    mixer.configure(parseAudioSettings({ spatial: "equalPower", buses: BUSES }).settings);
    const { backend } = rig();
    backend.play(req({ attenuation: { minDistance: 1, maxDistance: 9, rolloff: "inverse" } }));
    await flush();
    expect(sound().options.spatialPanningModel).toBe("equalpower");
  });

  it("sets the listener's position and orientation, from before the engine existed and after", async () => {
    const { backend } = rig();
    backend.setListener({ position: { x: 1, y: 2, z: 3 }, forward: { x: -1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } });
    backend.play(req());
    await flush();
    const l = engine().listener;
    expect(l.position).toMatchObject({ x: 1, y: 2, z: 3 });
    // Turned a quarter turn: a unit quaternion that isn't the identity.
    expect(Math.hypot(l.rotationQuaternion.x, l.rotationQuaternion.y, l.rotationQuaternion.z, l.rotationQuaternion.w)).toBeCloseTo(1);
    expect(l.rotationQuaternion.w).toBeLessThan(0.99);
    const updates = l.updates;
    backend.setListener({ position: { x: 7, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } });
    expect(l.position).toMatchObject({ x: 7, y: 0, z: 0 });
    expect([l.rotationQuaternion.x, l.rotationQuaternion.y, l.rotationQuaternion.z, l.rotationQuaternion.w].map((v) => Math.abs(v))).toEqual([0, 0, 0, 1]);
    expect(l.updates).toBeGreaterThan(updates);
  });
});

describe("BabylonBackend mixer features", () => {
  const tick = (seconds: number) => mixer.update(seconds);
  const mixConfig = {
    buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }, { name: "Music", parent: "Master" }],
    snapshots: [{ name: "Quiet", volumes: { Music: 0.25 } }],
    ducking: [{ trigger: "SFX", target: "Music", amount: 0.4, attack: 0.1, release: 0.1 }],
  };

  it("carries a snapshot's gain to the bus volume as the mixer fades to it", async () => {
    mixer.configure(parseAudioSettings(mixConfig).settings);
    const { backend } = rig();
    backend.play(req({ bus: "Music" }));
    await flush();
    mixer.onChange(() => backend.applyMix(mixer.resolveAll()));
    mixer.snapshot("Quiet", 0);
    tick(0.016);
    expect(bus("Music").volume).toBeCloseTo(0.25);
    mixer.clearSnapshot(0);
    tick(0.016);
    expect(bus("Music").volume).toBeCloseTo(1);
  });

  it("ducks the target bus while a trigger-bus voice plays, for every way a voice can end", async () => {
    mixer.configure(parseAudioSettings(mixConfig).settings);
    const { backend } = rig();
    mixer.onChange(() => backend.applyMix(mixer.resolveAll()));
    const duck = () => {
      tick(1);
      return bus("Music").volume;
    };
    const first = backend.play(req())!;
    await flush();
    expect(duck()).toBeCloseTo(0.4);
    first.stop();
    expect(duck()).toBeCloseTo(1);
    // A clip that ends on its own.
    backend.play(req());
    await flush();
    expect(duck()).toBeCloseTo(0.4);
    sound(1).finish();
    expect(duck()).toBeCloseTo(1);
    // A fade-out ends the voice's bookkeeping at once: the duck releases as it begins.
    const faded = backend.play(req())!;
    await flush();
    expect(duck()).toBeCloseTo(0.4);
    faded.stop(0.5);
    expect(mixer.bus("SFX").activeVoices).toBe(0);
    expect(duck()).toBeCloseTo(1);
    // A voice moved onto the trigger bus ducks, and off it releases.
    const mover = backend.play(req({ bus: "Music" }))!;
    await flush();
    expect(duck()).toBeCloseTo(1);
    mover.setBus("SFX");
    expect(duck()).toBeCloseTo(0.4);
    mover.setBus("Music");
    expect(duck()).toBeCloseTo(1);
    // A failed load.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    babylonMock.failUrls.add("asset://bad.wav");
    const bad = backend.play(req({ url: "asset://bad.wav" }))!;
    expect(duck()).toBeCloseTo(0.4);
    await flush();
    expect(bad.reason).toBe("failed");
    expect(duck()).toBeCloseTo(1);
    // Dispose releases every bus.
    backend.play(req());
    expect(duck()).toBeCloseTo(0.4);
    backend.dispose();
    expect(mixer.bus("SFX").activeVoices).toBe(0);
    tick(1);
    expect(mixer.resolveAll().find((b) => b.name === "Music")!.gain).toBeCloseTo(1);
  });

  it("releases a trigger bus's count when the bus cap stops the oldest voice", async () => {
    mixer.configure(parseAudioSettings({ ...mixConfig, buses: [{ name: "Master" }, { name: "SFX", parent: "Master", maxVoices: 1 }, { name: "Music", parent: "Master" }] }).settings);
    const { backend } = rig();
    backend.play(req());
    backend.play(req());
    backend.play(req());
    expect(mixer.bus("SFX").activeVoices).toBe(1);
    await flush();
    sound().finish();
    expect(mixer.bus("SFX").activeVoices).toBe(0);
  });

  it("applies only the resolved gain: a snapshot's low-pass and bus effects have no node on the fallback", async () => {
    mixer.configure(parseAudioSettings({
      buses: [{ name: "Master" }, { name: "SFX", parent: "Master", effects: [{ type: "lowpass", frequency: 800 }] }],
      snapshots: [{ name: "Muffled", lowpass: { SFX: 500 } }],
    }).settings);
    const { backend } = rig();
    backend.play(req());
    await flush();
    mixer.snapshot("Muffled", 0);
    mixer.update(0.016);
    backend.applyMix(mixer.resolveAll());
    expect(bus("SFX").volume).toBe(1);
    expect(Object.keys(bus("SFX").options).filter((k) => k !== "outBus" && k !== "volume")).toEqual([]);
  });
});

describe("BabylonBackend voice counts", () => {
  const sfx = () => mixer.bus("SFX").activeVoices;
  const music = () => mixer.bus("Music").activeVoices;

  it("counts a voice from play until it ends, exactly once each way", async () => {
    const { backend } = rig();
    const v = backend.play(req())!;
    expect(sfx()).toBe(1);
    await flush();
    expect(sfx()).toBe(1);
    v.stop();
    v.stop();
    expect(sfx()).toBe(0);
    sound().finish();
    expect(sfx()).toBe(0);
  });

  it("counts a clip that ends on its own", async () => {
    const { backend } = rig();
    backend.play(req());
    await flush();
    sound().finish();
    sound().finish();
    expect(sfx()).toBe(0);
  });

  it("moves the count with setBus, also while the sound is loading", async () => {
    const { backend } = rig();
    const a = backend.play(req())!;
    a.setBus("Music");
    expect([sfx(), music()]).toEqual([0, 1]);
    await flush();
    expect(sound().outBus).toBe(bus("Music"));
    a.setBus("SFX");
    expect([sfx(), music()]).toEqual([1, 0]);
    expect(sound().outBus).toBe(bus("SFX"));
    a.setBus("SFX");
    expect([sfx(), music()]).toEqual([1, 0]);
    a.stop();
    expect([sfx(), music()]).toEqual([0, 0]);
    a.setBus("Music");
    expect([sfx(), music()]).toEqual([0, 0]);
  });

  it("drops the count when the load fails, with reason failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    babylonMock.failUrls.add("asset://a.wav");
    const { backend } = rig();
    const v = backend.play(req())!;
    expect(v.playing).toBe(true);
    await flush();
    expect(v.playing).toBe(false);
    expect(v.reason).toBe("failed");
    expect(sfx()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("fails every voice, with one warning, when the engine can't start", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    babylonMock.failEngine = new Error("no audio");
    const { backend } = rig();
    const a = backend.play(req())!;
    const b = backend.play(req())!;
    await flush();
    expect([a.reason, b.reason]).toEqual(["failed", "failed"]);
    expect(sfx()).toBe(0);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("could not start"))).toHaveLength(1);
  });

  it("never reports another reason: a stopped or finished voice has none", async () => {
    const { backend } = rig();
    const v = backend.play(req())!;
    await flush();
    expect(v.reason).toBeNull();
    v.stop();
    expect(v.reason).toBeNull();
  });

  it("stops every voice on dispose and refuses plays after it", async () => {
    const { backend } = rig();
    const a = backend.play(req())!;
    backend.play(req({ bus: "Music" }));
    await flush();
    backend.dispose();
    expect(a.playing).toBe(false);
    expect([sfx(), music()]).toEqual([0, 0]);
    expect(backend.play(req())).toBeNull();
    expect(engine().disposed).toBe(true);
  });
});

describe("BabylonBackend setters before the sound is ready", () => {
  it("applies the latest values when the sound exists", async () => {
    const { backend } = rig();
    const release = babylonMock.hold();
    const v = backend.play(req({ volume: 0.5, pitch: 2 }))!;
    v.setVolume(0.25);
    v.setPitch(1.5);
    v.setAttenuation({ minDistance: 2, maxDistance: 20, rolloff: "linear" });
    v.setPosition({ x: 1, y: 2, z: 3 });
    v.setBus("Music");
    v.fade(0.5, 0.2);
    await flush();
    expect(babylonMock.engines).toHaveLength(0);
    release();
    await flush();
    const s = sound();
    expect(s.outBus).toBe(bus("Music"));
    expect(s.options).toMatchObject({ volume: 0.25, playbackRate: 1.5, spatialDistanceModel: "linear", spatialMinDistance: 2, spatialMaxDistance: 20 });
    expect(s.spatial.position).toMatchObject({ x: 1, y: 2, z: 3 });
    expect(s.plays).toHaveLength(1);
    // The fade runs from where the sound started, over the time asked.
    expect(s.ramps.at(-1)).toEqual({ value: expect.closeTo(0.125), duration: 0.2 });
    expect(mixer.bus("Music").activeVoices).toBe(1);
    expect(mixer.bus("SFX").activeVoices).toBe(0);
  });

  it("does not start a sound paused before it was ready until it is resumed", async () => {
    const { backend } = rig();
    const release = babylonMock.hold();
    const v = backend.play(req())!;
    v.pause();
    release();
    await flush();
    expect(sound().plays).toHaveLength(0);
    expect(v.playing).toBe(true);
    v.resume();
    expect(sound().plays).toHaveLength(1);
    expect(sound().resumes).toBe(0);
  });

  it("drops a sound stopped before it was ready, without playing it", async () => {
    const { backend } = rig();
    const release = babylonMock.hold();
    const v = backend.play(req())!;
    v.stop(0.5);
    expect(v.playing).toBe(false);
    expect(mixer.bus("SFX").activeVoices).toBe(0);
    release();
    await flush();
    expect(babylonMock.engine.sounds).toHaveLength(0);
  });

  it("disposes a sound that was being created when the voice was stopped", async () => {
    const { backend } = rig();
    backend.play(req({ bus: "Music" }));
    await flush();
    const release = babylonMock.hold();
    const v = backend.play(req({ bus: "Music" }))!;
    await flush();
    v.stop();
    release();
    await flush();
    expect(sound(1).plays).toHaveLength(0);
    expect(sound(1).disposed).toBe(true);
  });

  it("ignores setters once the voice has ended", async () => {
    const { backend } = rig();
    const v = backend.play(req())!;
    await flush();
    v.stop();
    v.setVolume(0.9);
    v.setPitch(3);
    v.setBus("Music");
    v.setPosition({ x: 1, y: 1, z: 1 });
    v.fade(0, 1);
    expect(sound().volume).toBe(1);
    expect(mixer.bus("Music").activeVoices).toBe(0);
  });
});

describe("BabylonBackend maxVoices", () => {
  it("caps live voices on a bus by stopping the oldest, and tells each sound the cap as maxInstances", async () => {
    const { backend } = rig();
    const a = backend.play(req())!;
    const b = backend.play(req())!;
    const c = backend.play(req())!;
    expect([a.playing, b.playing, c.playing]).toEqual([false, true, true]);
    expect(mixer.bus("SFX").activeVoices).toBe(2);
    await flush();
    expect(engine().sounds).toHaveLength(2);
    expect(sound(0).maxInstances).toBe(2);
    // A bus with no cap, and another bus, are untouched.
    for (let i = 0; i < 5; i++) backend.play(req({ bus: "Music" }));
    expect(mixer.bus("Music").activeVoices).toBe(5);
    await flush();
    expect(engine().sounds.at(-1)!.maxInstances).toBe(Infinity);
  });

  it("enforces the cap when a voice moves onto the bus, keeping the mover", async () => {
    const { backend } = rig();
    const a = backend.play(req())!;
    const b = backend.play(req())!;
    const m = backend.play(req({ bus: "Music" }))!;
    m.setBus("SFX");
    expect([a.playing, b.playing, m.playing]).toEqual([false, true, true]);
    expect(mixer.bus("SFX").activeVoices).toBe(2);
    expect(mixer.bus("Music").activeVoices).toBe(0);
    await flush();
  });
});

describe("BabylonBackend debug and housekeeping", () => {
  it("reports itself as babylon, with voice counts and an empty voice list", async () => {
    const { backend } = rig();
    backend.play(req());
    backend.play(req({ bus: "Music" }));
    await flush();
    const info = backend.debug();
    expect(info.core).toMatchObject({ backend: "babylon", voices: 2 });
    expect(info.voices).toEqual([]);
    expect(info.counters.logicalVoices).toBe(2);
    expect(info.status).toBe("running");
    expect(backend.name).toBe("babylon");
  });

  it("keeps and reports the background mode, and update is a no-op", () => {
    const { backend } = rig();
    backend.setBackground("pause");
    expect(backend.debug().background).toBe("pause");
    expect(() => backend.update(0.016)).not.toThrow();
  });

  it("gives a priority no meaning", async () => {
    const { backend } = rig();
    const v = backend.play(req({ priority: 3 }))!;
    expect(() => v.setPriority(200)).not.toThrow();
    expect(v.id).toBeGreaterThan(0);
  });
});

// --- The engine-level behaviour of audioBackend.test.ts and spatialAudio.test.ts, on this backend -------------------

describe("the engine on BabylonBackend", () => {
  let game: Engine;
  let backend: BabylonBackend;
  let context: FakeContext;

  beforeEach(async () => {
    context = makeFakeContext("running");
    backend = new BabylonBackend({ createContext: () => context as unknown as AudioContext, unlockTarget: new EventTarget(), hostContext: () => null });
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "a.wav": "data:audio/wav;base64,AAAA", "boom.wav": "data:audio/wav;base64,AAAA" }));
    game = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "Music", parent: "Master" }] } } });
    setAudioBackend(backend);
    await SceneManager.load("s.json");
    game.world.render = {} as never;
  });

  it("plays an AudioSource on its output bus, falling back to Master", async () => {
    const src = GameObject.create("a").addBehavior(AudioSource, { clip: "asset:a.wav", output: "Music", playOnAwake: false });
    src.play();
    await flush();
    expect(sound(0).outBus).toBe(bus("Music"));
    src.output = "Gone";
    src.play();
    await flush();
    expect(sound(1).outBus).toBe(bus("Master"));
  });

  it("takes a bus and a volume for playOneShot, exposes the mixer, and reports a one-shot as playing until it ends", async () => {
    const h = Audio.playOneShot("asset:a.wav", { bus: "Music", volume: 0.5 });
    expect(h.playing).toBe(true);
    expect(h.reason).toBeNull();
    await flush();
    expect(sound().outBus).toBe(bus("Music"));
    expect(sound().volume).toBe(0.5);
    Audio.bus("Music").volume = 0.25;
    expect(Audio.bus("Music").effectiveGain).toBeCloseTo(0.25);
    expect(Audio.buses).toEqual(["Master", "Music"]);
    sound().finish();
    expect(h.playing).toBe(false);
  });

  it("moves a voice when the output changes while playing, and a voice's end lowers its bus's count", async () => {
    const src = GameObject.create("b").addBehavior(AudioSource, { clip: "asset:a.wav", playOnAwake: false });
    src.play();
    await flush();
    const music = Audio.bus("Music");
    const before = music.activeVoices;
    src.output = "Music";
    src._sync();
    expect(sound().outBus).toBe(bus("Music"));
    expect(music.activeVoices).toBe(before + 1);
    sound().finish();
    expect(music.activeVoices).toBe(before);
  });

  it("gives status running, a handle reason null and a debug with an empty voice list", async () => {
    expect(Audio.status).toBe("running");
    const h = Audio.playOneShot("asset:a.wav");
    expect(h.playing).toBe(true);
    expect(h.reason).toBeNull();
    await flush();
    expect(Audio.debug().voices).toEqual([]);
    expect(Audio.debug().core).toMatchObject({ backend: "babylon" });
  });

  it("plays a flat source without positioning it, with pitch", async () => {
    GameObject.create("n").addBehavior(AudioSource, { clip: "boom.wav", volume: 0.5, pitch: 1.5 });
    game.step(1 / 60);
    await flush();
    expect(sound().options).toMatchObject({ playbackRate: 1.5, volume: 0.5 });
    expect(sound().spatialTouched).toBe(false);
  });

  it("places a spatial source at its node with the rolloff settings, and follows the node", async () => {
    const n = GameObject.create("n");
    n.transform!.position.set(4, 5, 6);
    n.addBehavior(AudioSource, { clip: "boom.wav", spatial: true, minDistance: 2, maxDistance: 50, rolloff: "linear", loop: true });
    game.step(1 / 60);
    await flush();
    const s = sound();
    expect(s.spatial.position).toMatchObject({ x: 4, y: 5, z: 6 });
    expect(s.spatial).toMatchObject({ distanceModel: "linear", minDistance: 2, maxDistance: 50 });
    n.transform!.position.set(-1, 0, 9);
    game.step(1 / 60);
    expect(s.spatial.position).toMatchObject({ x: -1, y: 0, z: 9 });
  });

  it("plays one-shots flat, with a volume number, or spatially at a position", async () => {
    Audio.playOneShot("boom.wav", 0.4);
    Audio.playOneShot("boom.wav", { volume: 0.8, pitch: 0.5, position: new Vector3(3, 2, 1), minDistance: 4, maxDistance: 40 });
    await flush();
    expect(sound(0).options.volume).toBe(0.4);
    expect(sound(0).spatialTouched).toBe(false);
    expect(sound(1).options).toMatchObject({ volume: 0.8, playbackRate: 0.5, spatialMinDistance: 4, spatialMaxDistance: 40, spatialDistanceModel: "inverse" });
    expect(sound(1).spatial.position).toMatchObject({ x: 3, y: 2, z: 1 });
  });

  it("sets the listener from an AudioListener, and falls back to the main camera", async () => {
    Audio.playOneShot("boom.wav");
    const cam = GameObject.create("cam");
    cam.transform!.position.set(0, 0, 10);
    cam.addBehavior(Camera);
    game.step(1 / 60);
    await flush();
    expect(engine().listener.position).toMatchObject({ x: 0, y: 0, z: 10 });
    const ears = GameObject.create("ears");
    ears.transform!.position.set(7, 0, 0);
    ears.addBehavior(AudioListener);
    game.step(1 / 60);
    expect(engine().listener.position).toMatchObject({ x: 7, y: 0, z: 0 });
  });
});

describe("BabylonBackend audio.background (A3.4b)", () => {
  class Page {
    hidden = false;
    private readonly ls = new Set<() => void>();
    addEventListener(_: "visibilitychange", l: () => void): void {
      this.ls.add(l);
    }
    removeEventListener(_: "visibilitychange", l: () => void): void {
      this.ls.delete(l);
    }
    set(hidden: boolean): void {
      this.hidden = hidden;
      for (const l of [...this.ls]) l();
    }
  }

  async function started(mode: "mute" | "pause" | "play") {
    const page = new Page();
    const r = rig({ visibility: page });
    r.backend.setBackground(mode);
    r.backend.play(req());
    await flush();
    return { ...r, page };
  }

  it("mute: the engine's volume is 0 while hidden and back when visible; Audio.muted and the master volume are kept", async () => {
    const { backend, page } = await started("mute");
    backend.masterVolume = 0.5;
    expect(engine().volume).toBe(0.5);
    page.set(true);
    expect(engine().volume).toBe(0);
    backend.masterVolume = 0.8;
    expect(engine().volume).toBe(0);
    page.set(false);
    expect(engine().volume).toBe(0.8);
    backend.muted = true;
    page.set(true);
    page.set(false);
    expect(engine().volume).toBe(0);
  });

  it("pause: mutes, then suspends the context it owns; resumes it when visible", async () => {
    vi.useFakeTimers();
    const { page, context, backend } = await (async () => {
      const page = new Page();
      const r = rig({ visibility: page });
      r.backend.setBackground("pause");
      r.backend.play(req());
      await vi.advanceTimersByTimeAsync(50);
      return { ...r, page };
    })();
    page.set(true);
    expect(engine().volume).toBe(0);
    expect(context.suspends).toBe(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(context.suspends).toBe(1);
    expect(context.state).toBe("suspended");
    page.set(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(context.state).toBe("running");
    expect(engine().volume).toBe(1);
    backend.dispose();
  });

  it("play: nothing is muted or suspended", async () => {
    const { page, context } = await started("play");
    page.set(true);
    expect(engine().volume).toBe(1);
    expect(context.suspends).toBe(0);
    page.set(false);
    expect(engine().volume).toBe(1);
  });

  it("a context shared with the core host is only muted on pause (the host's policy owns it)", async () => {
    vi.useFakeTimers();
    const page = new Page();
    const shared = makeFakeContext("running");
    const backend = new BabylonBackend({ visibility: page, hostContext: () => shared as unknown as AudioContext, unlockTarget: new EventTarget() });
    live.push(backend);
    backend.configureBuses(mixer);
    backend.setBackground("pause");
    backend.play(req());
    await vi.advanceTimersByTimeAsync(50);
    page.set(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(engine().volume).toBe(0);
    expect(shared.suspends).toBe(0);
  });
});
