// The Babylon fallback's spatial sound (ADR 0162 F1/F2, api-and-models §8, one case per row of the fallback table):
// Babylon's own panner from attenuation, the listener, main's Doppler and occlusion passes over the backend's view
// (occlusion gain only, Doppler on decoded clips only), filters and aux sends skipped with one warning, ambisonic clips
// as their W channel in mono, and inert reverb zones. Against the mocked AudioV2 engine, through the shared rig.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, SceneManager } from "../../../myco";
import { mixer } from "../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../engine/audio/settings";
import type { World } from "../../../engine/core/World";
import { babylonMock, type MockBus } from "../testing/babylonMocks";
import { babylonRig, decodingContext, disposeBabylonRigs, engine, fakeDecoded, flush, playRequest, sound, warningsOf } from "../testing/babylonRig";
import { AudioReverbZone } from "./AudioReverbZone";
import { setAudioBackend } from "./backend";
import type { BabylonBackend } from "./babylonBackend";
import { voiceGen } from "./core/ids";
import { isSpatialPassHost, ListenerFrame, SpatialViewFlag } from "./core/spatial";
import { endAudioSession } from "./testing";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

describe("spatial sound", () => {
  const BUSES = [{ name: "Master" }, { name: "SFX", parent: "Master", maxVoices: 2 }, { name: "Music", parent: "Master" }];
  const configureMixer = (buses: unknown[] = BUSES): void => mixer.configure(parseAudioSettings({ buses }).settings);
  const req = playRequest;
  const rig = babylonRig;
  const bus = (name: string): MockBus => engine().buses.find((b) => b.name === name)!;

  beforeEach(() => {
    babylonMock.reset();
    configureMixer();
  });
  afterEach(() => {
    vi.useRealTimers();
    setAudioBackend(null);
    disposeBabylonRigs();
    vi.restoreAllMocks();
  });

  describe("BabylonBackend spatial sound", () => {
    it("makes a sound spatial from its attenuation: distance model, min, max, rolloff factor 1", async () => {
      const { backend } = rig();
      const v = backend.play(req({ attenuation: { minDistance: 2, maxDistance: 50, rolloff: "linear" }, position: { x: 4, y: 5, z: 6 } }))!;
      await flush();
      const s = sound();
      expect(s.options).toMatchObject({ spatialEnabled: true, spatialDistanceModel: "linear", spatialMinDistance: 2, spatialMaxDistance: 50, spatialRolloffFactor: 1, spatialPanningModel: "HRTF" });
      expect(s.spatial.distanceModel).toBe("linear");
      expect(s.spatial.position).toMatchObject({ x: 4, y: 5, z: -6 }); // Web Audio axes: z negated (ADR 0164)
      v.setPosition({ x: -1, y: 0, z: 9 });
      expect(s.spatial.position).toMatchObject({ x: -1, y: 0, z: -9 });
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
      expect(sound().spatial.position).toMatchObject({ x: 1, y: 2, z: -3 });
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
      expect(l.position).toMatchObject({ x: 1, y: 2, z: -3 });
      // Turned a quarter turn: a unit quaternion that isn't the identity.
      expect(Math.hypot(l.rotationQuaternion.x, l.rotationQuaternion.y, l.rotationQuaternion.z, l.rotationQuaternion.w)).toBeCloseTo(1);
      expect(l.rotationQuaternion.w).toBeLessThan(0.99);
      const updates = l.updates;
      backend.setListener({ position: { x: 7, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } });
      expect(l.position).toMatchObject({ x: 7, y: 0, z: 0 });
      expect([l.rotationQuaternion.x, l.rotationQuaternion.y, l.rotationQuaternion.z, l.rotationQuaternion.w].map((v) => Math.abs(v))).toEqual([0, 0, 0, 1]);
      expect(l.updates).toBeGreaterThan(updates);
    });
  });
});

describe("main's passes and the §8 table (ADR 0162)", () => {
  /** One frame of the fallback's zone pass (ADR 0264 `SpatialPassHost.zones`) over `world`, as the audio system runs it. */
  function runZones(backend: BabylonBackend, world: World): void {
    const frame = new ListenerFrame();
    frame.world = world;
    backend.zones.run(frame, backend.spatialVoices, mixer.audioSettings);
  }

  const req = playRequest;
  const at = { x: 3, y: 0, z: 0 };

  /** `decoded`: what `decodeAudioData` returns for any bytes. */
  function rig(decoded = fakeDecoded(4, 48_000)) {
    const { context, created, fetched } = decodingContext(decoded);
    const { backend } = babylonRig({ context });
    return { backend, context, created, fetched };
  }

  let warn: ReturnType<typeof vi.spyOn>;
  const warnings = (): string[] => warningsOf(warn);

  beforeEach(() => {
    babylonMock.reset();
    mixer.configure(parseAudioSettings({ buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }] }).settings);
    endAudioSession();
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    setAudioBackend(null);
    disposeBabylonRigs();
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
      expect(backend.velocityOf(voice.id, out)).toBe(false);
      const next = backend.play(req({ position: at }))!;
      expect(next.id).not.toBe(voice.id); // the slot's generation moved on
    });

    it("AudioSource.velocity: setVelocity feeds velocityOf", async () => {
      const { backend } = rig();
      const voice = backend.play(req({ position: at }))!;
      await flush();
      voice.setVelocity({ x: 1, y: 2, z: 3 });
      const out = { x: 0, y: 0, z: 0 };
      expect(backend.velocityOf(voice.id, out)).toBe(true);
      expect(out).toEqual({ x: 1, y: 2, z: 3 });
    });
  });

  describe("F1 §8: occlusion is gain only", () => {
    it("takes volume x occGain through the sound's volume and drops the cutoff with one warning", async () => {
      const { backend } = rig();
      const a = backend.play(req({ volume: 0.8, position: at }))!;
      const b = backend.play(req({ volume: 1, position: at }))!;
      await flush();
      a.setOcclusion(0.5, 800);
      expect(sound(0).volume).toBeCloseTo(0.4, 6);
      b.setOcclusion(0.25, 500);
      expect(sound(1).volume).toBeCloseTo(0.25, 6);
      a.setOcclusion(1, 20000); // open again
      expect(sound(0).volume).toBeCloseTo(0.8, 6);
      expect(warnings().filter((w) => w.includes("low-pass cutoff is dropped"))).toHaveLength(1);
    });

    it("composes with the voice's fade and its own volume changes", async () => {
      const { backend } = rig();
      const a = backend.play(req({ volume: 1, position: at }))!;
      await flush();
      a.setOcclusion(0.5, 20000);
      a.setVolume(0.6);
      expect(sound().volume).toBeCloseTo(0.3, 6);
      a.fade(0.5, 0);
      expect(sound().volume).toBeCloseTo(0.15, 6);
    });

    it("applies a result that arrives before the sound is ready", async () => {
      const { backend } = rig();
      const release = babylonMock.hold();
      const a = backend.play(req({ volume: 1, position: at }))!;
      a.setOcclusion(0.5, 1000);
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
      voice.setDopplerRate(1.25);
      expect(sound().playbackRate).toBeCloseTo(2.5, 6);
      voice.setPitch(1);
      expect(sound().playbackRate).toBeCloseTo(1.25, 6);
      voice.setDopplerRate(1);
      expect(sound().playbackRate).toBe(1);
    });

    it("takes a factor handed to the view, and one that came before the sound was ready", async () => {
      const { backend } = rig();
      const release = babylonMock.hold();
      const voice = backend.play(req({ position: at }))!;
      voice.setDopplerRate(0.8);
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
      voice.setDopplerRate(1.5);
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
      for (let i = 0; i < 30; i++) runZones(backend, w);
      GameObject.create("z3").addBehavior(AudioReverbZone, {});
      runZones(backend, w);
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
      runZones(backend, node.world);
      expect(zoneWarnings()).toHaveLength(0);
      z.enabled = true;
      runZones(backend, node.world);
      expect(zoneWarnings()).toHaveLength(1);
    });
  });
});
