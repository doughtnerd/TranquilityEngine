// The Babylon fallback's engine, context and page: the engine made lazily on the shared context, the unlock layer and a
// core host's context, master volume and mute, `audio.background` (A3.4b), and the output device with its saved
// calibration (ADR 0248). Against the mocked AudioV2 engine (`../testing/babylonMocks`), through the shared rig.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { MemoryStorage, Storage } from "../../../engine/platform/Storage";
import { babylonMock, makeFakeContext, type MockBus } from "../testing/babylonMocks";
import { babylonRig, disposeBabylonRigs, engine, flush, playRequest } from "../testing/babylonRig";
import { setAudioBackend } from "./backend";
import type { BabylonBackend } from "./babylonBackend";
import { getCalibration, isCalibrationStale, setCalibration } from "./music/calibration";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

describe("engine, context and page", () => {
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

  describe("BabylonBackend engine", () => {
    it("creates nothing until the first play", async () => {
      const { backend, createContext } = rig();
      backend.setListener({ position: { x: 1, y: 2, z: 3 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } });
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
      const { backend, createContext } = rig({ host, unlockTarget: target });
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
      const { backend } = babylonRig({ visibility: page, host: shared, wire: false });
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
});

describe("output device and calibration (F-26, ADR 0248)", () => {
  const pageSettings = mixer.audioSettings;

  /** Lets the calibration's storage read or write land (a few promise turns). */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  /** A fake context that keeps `sinkchange` listeners by type and has a settable `sinkId`. */
  function sinkContext(sinkId: string) {
    const base = makeFakeContext("running");
    const byType = new Map<string, Set<() => void>>();
    const ctx = Object.assign(base, {
      sinkId,
      addEventListener(type: string, l: () => void) {
        if (!byType.has(type)) byType.set(type, new Set());
        byType.get(type)!.add(l);
      },
      removeEventListener(type: string, l: () => void) {
        byType.get(type)?.delete(l);
      },
      fire(type: string) {
        for (const l of [...(byType.get(type) ?? [])]) l();
      },
      count: (type: string) => byType.get(type)?.size ?? 0,
    });
    return ctx;
  }

  let media: EventTarget;

  async function start(ctx: ReturnType<typeof sinkContext>): Promise<BabylonBackend> {
    const { backend } = babylonRig({ context: ctx, wire: false });
    setAudioBackend(backend);
    // The context is created lazily, on the first sound.
    backend.music!.admitGroup({ instance: 1, group: 1, members: [{ stem: "a", play: { path: "a.wav", url: "asset://a.wav", loop: false, stream: false, bus: "Music", group: 1 }, startFrame: 0, loop: false }] });
    await flush();
    await settle();
    return backend;
  }

  beforeEach(async () => {
    babylonMock.reset();
    mixer.configure(parseAudioSettings({ buses: [{ name: "Master" }, { name: "Music", parent: "Master" }] }).settings);
    Storage.use(new MemoryStorage());
    media = new EventTarget();
    vi.stubGlobal("navigator", { mediaDevices: media });
    await Storage.save("audio.calibration.sinkA", { seconds: 0.045 }, "settings");
    await Storage.save("audio.calibration.sinkB", { seconds: -0.02 }, "settings");
  });
  afterEach(() => {
    setAudioBackend(null);
    disposeBabylonRigs();
    mixer.configure(pageSettings);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("Babylon fallback: saved calibration per output device", () => {
    it("loads the stored offset for the context's sink at start", async () => {
      await start(sinkContext("sinkA"));
      expect(getCalibration()).toBe(0.045);
      expect(isCalibrationStale()).toBe(false);
    });

    it("leaves the value alone at start when the sink has none stored", async () => {
      setCalibration(0.01);
      await settle();
      await start(sinkContext("sinkNew"));
      expect(getCalibration()).toBe(0.01);
    });

    it("adopts a calibrated sink's offset on sinkchange", async () => {
      const ctx = sinkContext("sinkA");
      await start(ctx);
      ctx.sinkId = "sinkB";
      ctx.fire("sinkchange");
      await settle();
      expect(getCalibration()).toBe(-0.02);
      expect(isCalibrationStale()).toBe(false);
    });

    it("keeps the value and turns calibrationStale true on an uncalibrated sink, and on devicechange", async () => {
      const ctx = sinkContext("sinkA");
      await start(ctx);
      ctx.sinkId = "sinkNew";
      ctx.fire("sinkchange");
      await settle();
      expect(getCalibration()).toBe(0.045);
      expect(isCalibrationStale()).toBe(true);
      setCalibration(0.045); // recalibrated
      expect(isCalibrationStale()).toBe(false);
      media.dispatchEvent(new Event("devicechange"));
      await settle();
      expect(isCalibrationStale()).toBe(true);
    });

    it("removes its listeners on dispose", async () => {
      const ctx = sinkContext("sinkA");
      const backend = await start(ctx);
      expect(ctx.count("sinkchange")).toBe(1);
      backend.dispose();
      expect(ctx.count("sinkchange")).toBe(0);
      ctx.sinkId = "sinkB";
      ctx.fire("sinkchange");
      media.dispatchEvent(new Event("devicechange"));
      await settle();
      expect(getCalibration()).toBe(0.045);
      expect(isCalibrationStale()).toBe(false);
    });
  });
});
