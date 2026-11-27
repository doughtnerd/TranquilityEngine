// The Babylon fallback's voices: decoded and streamed sounds, starts, setters before and after the sound is ready, pause,
// stop and fades, voice counts and load failures, `maxVoices`, region loops and release (ADR 0158 §4), clip durations,
// debug rows, stamped ramps and seeks on every voice (ADR 0264), and the engine-level behaviours of the fake backend's
// tests run against this backend. Against the mocked AudioV2 engine, through the shared rig.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, Camera, Engine, GameObject, SceneManager, Vector3 } from "../../../myco";
import { mixer } from "../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { babylonMock, type FakeContext, type MockBus, type MockSound } from "../testing/babylonMocks";
import { babylonRig, disposeBabylonRigs, engine, flush, playRequest, sound } from "../testing/babylonRig";
import { Audio } from "./Audio";
import { AudioListener, AudioSource } from "./index";
import { setAudioBackend, type PlayRequest } from "./backend";
import type { BabylonBackend } from "./babylonBackend";
import { endAudioSession } from "./testing";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

describe("voices", () => {
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

    it("plays a spatial stream clip flat (HTML5 audio), with one warning per asset", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { backend } = rig();
      const attenuation = { minDistance: 2, maxDistance: 50, rolloff: "linear" as const };
      const v = backend.play(req({ path: "flat.ogg", stream: true, bus: "Music", attenuation, position: { x: 4, y: 5, z: 6 } }))!;
      await flush();
      const s = sound();
      expect(s.kind).toBe("streaming");
      expect("spatialEnabled" in s.options).toBe(false);
      v.setAttenuation(attenuation);
      v.setPosition({ x: 1, y: 2, z: 3 });
      expect(s.spatialTouched).toBe(false);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("flat.ogg"))).toHaveLength(1);
      warn.mockRestore();
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
      expect(s.spatial.position).toMatchObject({ x: 1, y: 2, z: -3 });
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

    it("puts on the sound a volume, pitch or Doppler change made while the sound was being created", async () => {
      const { backend } = rig();
      backend.play(req());
      await flush(); // the engine and the clip's buffer exist
      const release = babylonMock.hold();
      const v = backend.play(req({ volume: 0.5 }))!;
      await flush(); // the sound is being created with volume 0.5 and rate 1
      expect(engine().sounds).toHaveLength(1);
      v.setVolume(0.25);
      v.setPitch(1.5);
      v.setDopplerRate(2);
      release();
      await flush();
      expect(sound(1).options).toMatchObject({ volume: 0.5, playbackRate: 1 });
      expect(sound(1).volume).toBe(0.25);
      expect(sound(1).playbackRate).toBe(3);
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

  describe("the engine on BabylonBackend", () => {
    let game: Engine;
    let backend: BabylonBackend;
    let context: FakeContext;

    beforeEach(async () => {
      ({ backend, context } = babylonRig({ wire: false }));
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
      game.step(1 / 60); // the audio system syncs the source
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
      expect(s.spatial.position).toMatchObject({ x: 4, y: 5, z: -6 });
      expect(s.spatial).toMatchObject({ distanceModel: "linear", minDistance: 2, maxDistance: 50 });
      n.transform!.position.set(-1, 0, 9);
      game.step(1 / 60);
      expect(s.spatial.position).toMatchObject({ x: -1, y: 0, z: -9 });
    });

    it("plays one-shots flat, with a volume number, or spatially at a position", async () => {
      Audio.playOneShot("boom.wav", 0.4);
      Audio.playOneShot("boom.wav", { volume: 0.8, pitch: 0.5, position: new Vector3(3, 2, 1), minDistance: 4, maxDistance: 40 });
      await flush();
      expect(sound(0).options.volume).toBe(0.4);
      expect(sound(0).spatialTouched).toBe(false);
      expect(sound(1).options).toMatchObject({ volume: 0.8, playbackRate: 0.5, spatialMinDistance: 4, spatialMaxDistance: 40, spatialDistanceModel: "inverse" });
      expect(sound(1).spatial.position).toMatchObject({ x: 3, y: 2, z: -1 });
    });

    it("sets the listener from an AudioListener, and falls back to the main camera", async () => {
      Audio.playOneShot("boom.wav");
      const cam = GameObject.create("cam");
      cam.transform!.position.set(0, 0, 10);
      cam.addBehavior(Camera);
      game.step(1 / 60);
      await flush();
      expect(engine().listener.position).toMatchObject({ x: 0, y: 0, z: -10 });
      const ears = GameObject.create("ears");
      ears.transform!.position.set(7, 0, 0);
      ears.addBehavior(AudioListener);
      game.step(1 / 60);
      expect(engine().listener.position).toMatchObject({ x: 7, y: 0, z: 0 });
    });
  });
});

describe("event loops and clip durations (ADR 0158 §4)", () => {
  const req = (extra: Partial<PlayRequest> = {}): PlayRequest => playRequest({ bus: "Master", ...extra });
  const sound = (i = 0): MockSound & { loopStart?: number; loopEnd?: number } => engine().sounds[i]!;
  const make = (): BabylonBackend => babylonRig().backend;

  beforeEach(() => {
    babylonMock.reset();
    endAudioSession();
    mixer.configure(parseAudioSettings({ buses: [{ name: "Master" }] }).settings);
  });
  afterEach(() => {
    setAudioBackend(null);
    disposeBabylonRigs();
    vi.restoreAllMocks();
  });

  describe("Babylon event loops", () => {
    it("setLoop sets loopStart, loopEnd and loop on a ready sound; release clears loop", async () => {
      const backend = make();
      const voice = backend.play(req({ loop: true }))!;
      await flush();
      voice.setLoop(1.5, 3, true);
      expect(sound()).toMatchObject({ loopStart: 1.5, loopEnd: 3, loop: true });
      voice.setLoop(1.5, 3, false);
      expect(sound().loop).toBe(false);
      expect(voice.playing).toBe(true);
    });

    it("applies a setLoop made before the sound is ready", async () => {
      const backend = make();
      const voice = backend.play(req())!;
      voice.setLoop(0.5, 2, true);
      await flush();
      expect(sound()).toMatchObject({ loopStart: 0.5, loopEnd: 2, loop: true });
    });

    it("a streamed clip loops whole and warns once", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const backend = make();
      const voice = backend.play(req({ stream: true, loop: true }))!;
      await flush();
      voice.setLoop(1, 2, true);
      voice.setLoop(1, 2, true);
      expect(sound().loop).toBe(true);
      expect(sound().loopStart).toBeUndefined();
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("loops whole"))).toHaveLength(1);
      voice.setLoop(1, 2, false);
      expect(sound().loop).toBe(false);
    });
  });

  describe("Babylon clip durations and debug rows", () => {
    it("clipDuration is null until the buffer is loaded, then its length", async () => {
      const backend = make();
      expect(backend.clipDuration("a.wav")).toBeNull();
      backend.play(req());
      await flush();
      expect(backend.clipDuration("a.wav")).toBe(1); // MockBuffer.duration
      expect(backend.clipDuration("other.wav")).toBeNull();
    });

    it("debug rows carry the event from PlayRequest.group, none for 0 or absent", async () => {
      const backend = make();
      backend.play(req({ group: 7 }));
      backend.play(req({ group: 0 }));
      backend.play(req());
      await flush();
      // Only event voices have rows on the fallback (plain voices keep the empty list the existing tests pin).
      expect(backend.debug().voices.map((v) => v.event)).toEqual([7]);
    });
  });
});

describe("ramps and seeks (ADR 0264)", () => {
  let backend: BabylonBackend;
  let context: FakeContext;

  beforeEach(() => {
    babylonMock.reset();
    mixer.configure(parseAudioSettings({ buses: [{ name: "Master" }, { name: "Music", parent: "Master" }] }).settings);
    ({ backend, context } = babylonRig());
  });
  afterEach(() => {
    vi.useRealTimers();
    disposeBabylonRigs();
    vi.restoreAllMocks();
  });

  const sounds = (): MockSound[] => engine().sounds;
  const setTime = (t: number): void => {
    context.currentTime = t;
    engine().currentTime = t;
  };

  describe("Babylon fallback: every voice takes ramps and seeks (ADR 0264)", () => {
    const plain = (extra: Partial<PlayRequest> = {}): PlayRequest => ({ path: "sfx.ogg", url: "sfx.ogg", loop: false, stream: false, bus: "Master", ...extra });

    it("a plain voice runs a stamped fade at its time and stops at its end", async () => {
      const v = backend.play(plain())!;
      await flush();
      vi.useFakeTimers();
      setTime(0);
      await vi.advanceTimersByTimeAsync(10);
      const s = sounds()[0]!;
      v.fadeShaped({ to: 0, seconds: 0.5, law: "linear", at: 1, stopAtEnd: true });
      expect(s.ramps).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.ramps).toEqual([{ value: 0, duration: 0.5 }]);
      await vi.advanceTimersByTimeAsync(600);
      expect(v.playing).toBe(false);
    });

    it("a seek before the start is where the sound starts; after it, the sound moves there", async () => {
      const v = backend.play(plain())!;
      v.seek(1.25);
      await flush();
      const s = sounds()[0]!;
      expect(s.plays).toEqual([{ startOffset: 1.25 }]);
      v.seek(0.5);
      expect(s.currentTime).toBe(0.5);
    });
  });
});
