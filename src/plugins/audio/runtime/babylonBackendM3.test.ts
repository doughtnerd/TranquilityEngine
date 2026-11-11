// ADR 0162 F1 (#150): api-and-models §8, the Babylon fallback table, one case per row against the mocked AudioV2 engine.
//
// | Feature | On the fallback |
// | Bed, `bed`/`bedPriority`, panner kinds | none: Babylon's own panner (`spatialSoundOptions`) |
// | Occlusion | gain only: main runs the rays and smoothing, the backend takes `volume x occGain` through `setVolume`; the cutoff is dropped; one warning |
// | Doppler | the factor multiplies `playbackRate`; only for decoded clips (a streamed clip plays flat as HTML5 audio, so streams get no Doppler) |
// | Event filters, `lowpass`/`highpass`, aux sends | skipped, one warning per asset |
// | Ambisonic clips | channel 0 (W) as mono at the clip's gain, one warning; no rotation. The backend ignores `stream` for them: it decodes
// |   with `decodeAudioData`, copies channel 0 into a mono `AudioBuffer` and passes that to `createSoundAsync`; clips decoding to over 64 MB are refused with a warning |
// | Reverb zones | inert, one warning (F2, the last describe) |
// | LISTENER, `AudioListener.velocity` | listener pose as today; velocity feeds Doppler |
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { Assets, Engine, GameObject, SceneManager } from "../../../myco";
import { AudioReverbZone } from "./AudioReverbZone";
import { babylonMock, makeFakeContext, type FakeContext, type MockEngine, type MockSound } from "../testing/babylonMocks";
import { setAudioBackend, type PlayRequest } from "./backend";
import { BabylonBackend } from "./babylonBackend";
import { _resetHandleWarningsForTests } from "./core/handle";
import { voiceGen } from "./core/ids";
import { isSpatialPassHost, SpatialViewFlag } from "./core/spatial";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

const req = (extra: Partial<PlayRequest> = {}): PlayRequest => ({ path: "a.wav", url: "asset://a.wav", loop: false, stream: false, bus: "SFX", ...extra });
const at = { x: 3, y: 0, z: 0 };

/** A decoded clip as `decodeAudioData` returns it: `channels` channels of `frames` frames, channel c filled with c + 1. */
function fakeDecoded(channels: number, frames: number, rate = 48_000) {
  const data = Array.from({ length: channels }, (_, c) => new Float32Array(Math.min(frames, 16)).fill(c + 1));
  return { numberOfChannels: channels, length: frames, sampleRate: rate, duration: frames / rate, getChannelData: (c: number) => data[c]! };
}

interface Created {
  channels: number;
  length: number;
  rate: number;
  copied: Float32Array | null;
  duration: number;
}

interface Rig {
  backend: BabylonBackend;
  context: FakeContext;
  created: Created[];
  fetched: string[];
}

const live: BabylonBackend[] = [];

/** `decoded`: what `decodeAudioData` returns for any bytes. */
function rig(decoded = fakeDecoded(4, 48_000)): Rig {
  const context = makeFakeContext("running");
  const created: Created[] = [];
  const fetched: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  });
  Object.assign(context, {
    decodeAudioData: async () => decoded,
    createBuffer: (channels: number, length: number, rate: number) => {
      const c: Created = { channels, length, rate, copied: null, duration: length / rate };
      created.push(c);
      return Object.assign(c, { copyToChannel: (data: Float32Array) => { c.copied = data; } });
    },
  });
  const backend = new BabylonBackend({ createContext: () => context as unknown as AudioContext, unlockTarget: new EventTarget(), hostContext: () => null, visibility: null });
  live.push(backend);
  backend.configureBuses(mixer);
  backend.applyMix(mixer.resolveAll());
  return { backend, context, created, fetched };
}

const engine = (): MockEngine => babylonMock.engine;
const sound = (i = 0): MockSound => engine().sounds[i]!;
let warn: ReturnType<typeof vi.spyOn>;
const warnings = (): string[] => warn.mock.calls.map((c: unknown[]) => String(c[0]));

beforeEach(() => {
  babylonMock.reset();
  mixer.configure(parseAudioSettings({ buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }] }).settings);
  _resetHandleWarningsForTests();
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setAudioBackend(null);
  for (const b of live.splice(0)) b.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("F1 §8: the backend runs main's passes", () => {
  it("is a SpatialPassHost whose view lists its voices with the right flags", async () => {
    const { backend } = rig();
    expect(isSpatialPassHost(backend)).toBe(true);
    backend.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } });
    backend.play(req({ position: at, occlusion: true, dopplerLevel: 2, world: 7 }));
    backend.play(req({ position: at, occlusion: false }));
    backend.play(req()); // flat
    backend.play(req({ position: at, stream: true })); // a stream plays flat: not spatial
    await flush();
    backend.collectSpatialVoices();
    const v = backend.spatialVoices;
    expect(v.count).toBe(4);
    const f = (k: number) => v.viewFlags[v.slots[k]!]!;
    expect(f(0) & SpatialViewFlag.SPATIAL).toBeTruthy();
    expect(f(0) & SpatialViewFlag.OCCLUSION).toBeTruthy();
    expect(f(1) & SpatialViewFlag.SPATIAL).toBeTruthy();
    expect(f(1) & SpatialViewFlag.OCCLUSION).toBe(0);
    expect(f(2) & SpatialViewFlag.SPATIAL).toBe(0);
    expect(f(3) & SpatialViewFlag.SPATIAL).toBe(0);
    expect(v.dopplerLevel[v.slots[0]!]).toBe(2);
    expect(v.world[v.slots[0]!]).toBe(7);
    expect(v.posX[v.slots[0]!]).toBe(3);
    expect(v.audibility0[v.slots[0]!]).toBeCloseTo(1 / 3, 5); // inverse model at 3 m
  });

  it("gives voices slot ids the passes can bind, and forgets an ended voice", async () => {
    const { backend } = rig();
    const voice = backend.play(req({ position: at }))!;
    expect(voiceGen(voice.id)).toBeGreaterThan(0);
    await flush();
    backend.collectSpatialVoices();
    expect(backend.spatialVoices.count).toBe(1);
    voice.stop();
    backend.collectSpatialVoices();
    expect(backend.spatialVoices.count).toBe(0);
    const out = { x: 9, y: 9, z: 9 };
    expect(backend._velocityOf(voice.id, out)).toBe(false);
    const next = backend.play(req({ position: at }))!;
    expect(next.id).not.toBe(voice.id); // the slot's generation moved on
  });

  it("AudioSource.velocity: setVelocity feeds _velocityOf", async () => {
    const { backend } = rig();
    const voice = backend.play(req({ position: at }))!;
    await flush();
    voice.setVelocity?.({ x: 1, y: 2, z: 3 });
    const out = { x: 0, y: 0, z: 0 };
    expect(backend._velocityOf(voice.id, out)).toBe(true);
    expect(out).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe("F1 §8: occlusion is gain only", () => {
  it("takes volume x occGain through the sound's volume and drops the cutoff with one warning", async () => {
    const { backend } = rig();
    const a = backend.play(req({ volume: 0.8, position: at }))!;
    const b = backend.play(req({ volume: 1, position: at }))!;
    await flush();
    a.setOcclusion?.(0.5, 800);
    expect(sound(0).volume).toBeCloseTo(0.4, 6);
    b.setOcclusion?.(0.25, 500);
    expect(sound(1).volume).toBeCloseTo(0.25, 6);
    a.setOcclusion?.(1, 20000); // open again
    expect(sound(0).volume).toBeCloseTo(0.8, 6);
    expect(warnings().filter((w) => w.includes("low-pass cutoff is dropped"))).toHaveLength(1);
  });

  it("composes with the voice's fade and its own volume changes", async () => {
    const { backend } = rig();
    const a = backend.play(req({ volume: 1, position: at }))!;
    await flush();
    a.setOcclusion?.(0.5, 20000);
    a.setVolume(0.6);
    expect(sound().volume).toBeCloseTo(0.3, 6);
    a.fade(0.5, 0);
    expect(sound().volume).toBeCloseTo(0.15, 6);
  });

  it("applies a result that arrives before the sound is ready", async () => {
    const { backend } = rig();
    const release = babylonMock.hold();
    const a = backend.play(req({ volume: 1, position: at }))!;
    a.setOcclusion?.(0.5, 1000);
    release();
    await flush();
    expect(sound().volume).toBeCloseTo(0.5, 6);
  });

  it("runs from the pass: a result handed to the view reaches the voice in that slot", async () => {
    const { backend } = rig();
    const voice = backend.play(req({ position: at }))!;
    await flush();
    backend.collectSpatialVoices();
    const slot = backend.spatialVoices.slots[0]!;
    backend.spatialVoices.setOcclusion(slot, 0.1, 400);
    expect(sound().volume).toBeCloseTo(0.1, 6);
    expect(voice.playing).toBe(true);
  });
});

describe("F1 §8: Doppler multiplies playbackRate on decoded clips only", () => {
  it("scales a decoded clip's rate with its pitch", async () => {
    const { backend } = rig();
    const voice = backend.play(req({ position: at, pitch: 2, dopplerLevel: 1 }))!;
    await flush();
    expect(sound().playbackRate).toBe(2);
    voice.setDopplerRate?.(1.25);
    expect(sound().playbackRate).toBeCloseTo(2.5, 6);
    voice.setPitch(1);
    expect(sound().playbackRate).toBeCloseTo(1.25, 6);
    voice.setDopplerRate?.(1);
    expect(sound().playbackRate).toBe(1);
  });

  it("takes a factor handed to the view, and one that came before the sound was ready", async () => {
    const { backend } = rig();
    const release = babylonMock.hold();
    const voice = backend.play(req({ position: at }))!;
    voice.setDopplerRate?.(0.8);
    release();
    await flush();
    expect(sound().options.playbackRate).toBeCloseTo(0.8, 6);
    backend.collectSpatialVoices();
    backend.spatialVoices.setDopplerRate(backend.spatialVoices.slots[0]!, 1.5);
    expect(sound().playbackRate).toBeCloseTo(1.5, 6);
  });

  it("leaves a streamed clip flat: no rate to set", async () => {
    const { backend } = rig();
    const voice = backend.play(req({ position: at, stream: true }))!;
    await flush();
    expect(sound().kind).toBe("streaming");
    const before = sound().playbackRate;
    voice.setDopplerRate?.(1.5);
    expect(sound().playbackRate).toBe(before);
    expect(sound().options.playbackRate).toBeUndefined();
  });
});

describe("F1 §8: filters and aux sends are skipped with one warning per asset", () => {
  it("warns once per asset for an event filter, and plays the sound unfiltered", async () => {
    const { backend } = rig();
    backend.play(req({ filter: { lowpass: 800 } }));
    backend.play(req({ filter: { highpass: 300 } }));
    backend.play(req({ path: "b.wav", url: "asset://b.wav", filter: { lowpass: 800, highpass: 300 } }));
    await flush();
    const w = warnings().filter((m) => m.includes("skips"));
    expect(w).toHaveLength(2);
    expect(w[0]).toContain("a.wav");
    expect(w[1]).toContain("b.wav");
    expect(engine().sounds).toHaveLength(3);
    expect(sound(0).playbackRate).toBe(1);
  });

  it("warns for an aux send, and not for filters at their off values", async () => {
    const { backend } = rig();
    backend.play(req({ filter: { lowpass: 20000, highpass: 20 } }));
    await flush();
    expect(warnings().filter((m) => m.includes("skips"))).toHaveLength(0);
    backend.play(req({ path: "c.wav", url: "asset://c.wav", aux: { bus: "SFX", level: 0.5 } }));
    backend.play(req({ path: "c.wav", url: "asset://c.wav", aux: { bus: "SFX", level: 1 } }));
    await flush();
    const w = warnings().filter((m) => m.includes("skips"));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("aux send");
  });
});

describe("F1 §8: ambisonic clips play W as mono", () => {
  it("decodes, copies channel 0 into a mono AudioBuffer and gives that to createSoundAsync, ignoring stream", async () => {
    const { backend, created, fetched } = rig(fakeDecoded(16, 48_000));
    const voice = backend.play(req({ path: "amb.wav", url: "asset://amb.wav", ambisonic: true, stream: true, volume: 0.7, position: at, attenuation: { minDistance: 1, maxDistance: 10, rolloff: "linear" } }))!;
    await flush();
    expect(fetched).toEqual(["asset://amb.wav"]);
    expect(engine().streamLoads).toEqual([]);
    expect(engine().bufferLoads).toEqual([]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ channels: 1, length: 48_000, rate: 48_000 });
    expect(Array.from(created[0]!.copied!.subarray(0, 3))).toEqual([1, 1, 1]); // channel 0
    expect(sound().kind).toBe("static");
    expect(sound().source).toBe(created[0]);
    expect(sound().volume).toBeCloseTo(0.7, 6); // the clip's gain
    expect(sound().spatialTouched).toBe(false); // no position, no rotation
    expect(voice.playing).toBe(true);
    expect(sound().state).toBe("started");
  });

  it("warns once per asset, and decodes a clip once however often it plays", async () => {
    const { backend, created } = rig(fakeDecoded(4, 48_000));
    backend.play(req({ path: "amb.wav", url: "asset://amb.wav", ambisonic: true }));
    backend.play(req({ path: "amb.wav", url: "asset://amb.wav", ambisonic: true }));
    await flush();
    expect(warnings().filter((m) => m.includes("W channel"))).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(engine().sounds).toHaveLength(2);
  });

  it("is not spatial in the view: no occlusion, no Doppler", async () => {
    const { backend } = rig();
    backend.play(req({ path: "amb.wav", url: "asset://amb.wav", ambisonic: true, position: at, dopplerLevel: 1 }));
    await flush();
    backend.collectSpatialVoices();
    const flags = backend.spatialVoices.viewFlags[backend.spatialVoices.slots[0]!]!;
    expect(flags & SpatialViewFlag.AMBISONIC).toBeTruthy();
    expect(flags & (SpatialViewFlag.SPATIAL | SpatialViewFlag.OCCLUSION)).toBe(0);
  });

  it("refuses a clip that decodes to over 64 MB, with a warning, and plays nothing", async () => {
    // 16 channels x 4 bytes x 1,100,000 frames = 70.4 MB.
    const { backend, created } = rig(fakeDecoded(16, 1_100_000));
    const voice = backend.play(req({ path: "big.wav", url: "asset://big.wav", ambisonic: true }))!;
    await flush();
    expect(engine().sounds).toHaveLength(0);
    expect(created).toHaveLength(0);
    expect(voice.playing).toBe(false);
    expect(voice.reason).toBe("failed");
    const w = warnings().filter((m) => m.includes("64 MB"));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("big.wav");
    // A second play of the refused clip does not warn again.
    backend.play(req({ path: "big.wav", url: "asset://big.wav", ambisonic: true }));
    await flush();
    expect(warnings().filter((m) => m.includes("64 MB"))).toHaveLength(1);
  });

  it("takes a clip right at the limit: 64,000,000 bytes (about 83 s of 1st order)", async () => {
    const { backend } = rig(fakeDecoded(4, 4_000_000)); // 4 x 4 x 4,000,000 = 64,000,000
    const voice = backend.play(req({ path: "edge.wav", url: "asset://edge.wav", ambisonic: true }))!;
    await flush();
    expect(voice.playing).toBe(true);
    expect(engine().sounds).toHaveLength(1);
  });
});

describe("F1 §8: listener velocity", () => {
  it("keeps the listener pose as today (velocity is main's: it feeds the Doppler pass, not the engine's listener)", async () => {
    const { backend } = rig();
    backend.play(req({ position: at }));
    await flush();
    backend.setListener({ position: { x: 1, y: 2, z: 3 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } });
    expect(engine().listener.position).toMatchObject({ x: 1, y: 2, z: -3 });
    backend.collectSpatialVoices();
    const i = backend.spatialVoices.slots[0]!;
    expect(backend.spatialVoices.audibility0[i]).toBeCloseTo(1 / Math.hypot(2, 2, 3), 5);
  });
});

describe("F2 §8: reverb zones are inert, one warning", () => {
  const zoneWarnings = () => warnings().filter((w) => w.includes("reverb zones"));
  const load = async () => {
    await Engine.create({ headless: true });
    await SceneManager.load("s.json");
  };

  it("warns once across many frames and zones, and changes nothing else", async () => {
    await load();
    const { backend } = rig();
    backend.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } });
    const a = GameObject.create("z1");
    const w = a.world;
    a.addBehavior(AudioReverbZone, { preset: "cave" });
    GameObject.create("z2").addBehavior(AudioReverbZone, {});
    expect(zoneWarnings()).toHaveLength(0);
    backend.play(req({ position: at }));
    await flush();
    const before = backend.debug();
    for (let i = 0; i < 30; i++) backend.noteReverbZones(w);
    GameObject.create("z3").addBehavior(AudioReverbZone, {});
    backend.noteReverbZones(w);
    expect(zoneWarnings()).toHaveLength(1);
    expect(zoneWarnings()[0]).toMatch(/audio core/);
    expect(warnings()).toHaveLength(1);
    expect(backend.debug().zones).toBeUndefined();
    expect(backend.debug().voices).toEqual(before.voices);
    expect(backend.debug().core).toEqual(before.core);
  });

  it("does not warn for a disabled zone, and warns when it is enabled", async () => {
    await load();
    const { backend } = rig();
    const node = GameObject.create("off");
    const z = node.addBehavior(AudioReverbZone, {});
    z.enabled = false;
    backend.noteReverbZones(node.world);
    expect(zoneWarnings()).toHaveLength(0);
    z.enabled = true;
    backend.noteReverbZones(node.world);
    expect(zoneWarnings()).toHaveLength(1);
  });
});
