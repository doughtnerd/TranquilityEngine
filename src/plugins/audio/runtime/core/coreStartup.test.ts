// The order of events at start-up (architecture §2.1, §3.1): a play that comes before the core's World service has
// loaded waits as a locked voice and moves onto the core when it registers; only a real failure falls back to
// "babylon", with one warning, for the page.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { audioBackend, isPendingCoreBackend, mixer, noteCoreUnavailable, registerCoreBackend, registerDefaultBackend, resetCoreFallbackState, setAudioBackend, type PlayRequest } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";

const loop = (): PlayRequest => ({ path: "music.ogg", url: "/music.ogg", loop: true, stream: false, bus: "Master", priority: 128 });
const oneShot = (): PlayRequest => ({ path: "flap.wav", url: "/flap.wav", loop: false, stream: false, bus: "Master", oneShot: true });

describe("audio.backend core: start-up order", () => {
  let warn: MockInstance<(...data: unknown[]) => void>;
  let savedKind: typeof mixer.audioSettings.backend;
  let fallback: FakeBackend;
  let makeFallback: ReturnType<typeof vi.fn<() => FakeBackend>>;
  let undoCore: (() => void) | null = null;

  beforeEach(() => {
    setAudioBackend(null);
    resetCoreFallbackState();
    savedKind = mixer.audioSettings.backend;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fallback = makeFakeBackend();
    makeFallback = vi.fn(() => fallback);
    registerDefaultBackend(makeFallback);
    mixer.audioSettings.backend = "core";
  });
  afterEach(() => {
    undoCore?.();
    undoCore = null;
    setAudioBackend(null);
    resetCoreFallbackState();
    mixer.audioSettings.backend = savedKind;
    warn.mockRestore();
    vi.restoreAllMocks();
  });

  it("a looping owned voice played before the core registers ends up playing on the core, never on the fallback", () => {
    // The first audioBackend() call comes before the core's service has loaded.
    const pending = audioBackend();
    expect(isPendingCoreBackend(pending)).toBe(true);
    expect(pending.status).toBe("locked");
    const voice = pending.play(loop())!;
    expect(voice.playing).toBe(true);
    expect(voice.reason).toBe("locked");
    // The holder (an AudioSource) keeps adjusting it while the core loads.
    voice.setVolume(0.5);
    voice.setPosition({ x: 1, y: 2, z: 3 });
    pending.masterVolume = 0.8;
    expect(pending.debug().counters.logicalVoices).toBe(1);

    const core = makeFakeBackend();
    undoCore = registerCoreBackend(() => core);

    expect(audioBackend()).toBe(core);
    expect(makeFallback).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(core.plays).toHaveLength(1);
    expect(core.plays[0]).toMatchObject({ path: "music.ogg", loop: true, volume: 0.5, position: { x: 1, y: 2, z: 3 } });
    expect(core.masterVolume).toBe(0.8);
    // The same voice object now forwards to the core's voice.
    const onCore = core.voices[0]!;
    expect(voice.playing).toBe(true);
    expect(voice.reason).toBeNull();
    expect(voice.id).toBe(onCore.id);
    voice.setVolume(0.25);
    expect(onCore.volume).toBe(0.25);
    voice.stop();
    expect(onCore.stopped).toBe(true);
    expect(voice.playing).toBe(false);
  });

  it("voices stopped while pending don't start, and stale one-shots are dropped (D5)", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const pending = audioBackend();
    const stopped = pending.play(loop())!;
    stopped.stop();
    const old = pending.play(oneShot())!;
    now.mockReturnValue(1800);
    const fresh = pending.play(oneShot())!;
    now.mockReturnValue(2500); // `old` is 1.5 s old, `fresh` 0.7 s
    const core = makeFakeBackend();
    undoCore = registerCoreBackend(() => core);
    expect(core.plays.map((p) => p.path)).toEqual(["flap.wav"]);
    expect(stopped.playing).toBe(false);
    expect(old.playing).toBe(false);
    expect(old.reason).toBeNull();
    expect(fresh.playing).toBe(true);
  });

  it("a real failure gives one warning and keeps the fallback for the page, carrying the pending voices", () => {
    const voice = audioBackend().play(loop())!;
    noteCoreUnavailable("audio core couldn't load (compile failed); using \"babylon\".");
    expect(audioBackend()).toBe(fallback);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[myco] audio core couldn't load (compile failed); using "babylon".`);
    expect(fallback.plays).toHaveLength(1);
    expect(voice.playing).toBe(true);
    // A core registering later doesn't switch mid-session, and nothing warns again.
    const core = makeFakeBackend();
    undoCore = registerCoreBackend(() => core);
    noteCoreUnavailable("another reason");
    expect(audioBackend()).toBe(fallback);
    expect(core.plays).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a failure known before the first call goes straight to the fallback with one warning", () => {
    noteCoreUnavailable("refused");
    expect(audioBackend()).toBe(fallback);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[myco] refused");
  });

  it("\"babylon\" never waits: the default backend at once, no warning", () => {
    mixer.audioSettings.backend = "babylon";
    expect(audioBackend()).toBe(fallback);
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaving \"core\" while it loads hands the pending voices to the default backend without a warning", () => {
    const voice = audioBackend().play(loop())!;
    mixer.audioSettings.backend = "babylon";
    expect(audioBackend()).toBe(fallback);
    expect(fallback.plays).toHaveLength(1);
    expect(voice.playing).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("ADR 0162 (K4): M3 values given while pending reach the real voice at the hand-over where it takes them, and are forwarded after", () => {
    const pending = audioBackend();
    const voice = pending.play(loop())!;
    voice.setVelocity!({ x: 1, y: 0, z: 0 });
    voice.setVelocity!({ x: 2, y: 0, z: 0 });
    voice.setOcclusion!(0.5, 3000);
    voice.setDopplerRate!(1.2);
    voice.setSpatialOptions!({ dopplerLevel: 2 });
    voice.setSpatialOptions!({ reverbSend: 0.5 });

    const core = makeFakeBackend();
    const options: unknown[] = [];
    const play = core.play.bind(core);
    // A voice that also takes Play edits (as the core's do); the fake's own voices don't.
    core.play = (req) => Object.assign(play(req)!, { setSpatialOptions: (o: unknown) => options.push(o) });
    undoCore = registerCoreBackend(() => core);
    expect(audioBackend()).toBe(core);
    const onCore = core.voices[0]!;
    // Only the latest of each, applied once.
    expect(onCore.events.filter((e) => e.kind === "velocity" || e.kind === "occlusion" || e.kind === "doppler")).toEqual([
      { kind: "velocity", value: { x: 2, y: 0, z: 0 } },
      { kind: "occlusion", gain: 0.5, lpHz: 3000 },
      { kind: "doppler", factor: 1.2 },
    ]);
    expect(options).toEqual([{ dopplerLevel: 2, reverbSend: 0.5 }]);
    // Forwarded after the hand-over.
    voice.setOcclusion!(0.25, 1000);
    voice.setDopplerRate!(0.9);
    voice.setVelocity!({ x: 0, y: 3, z: 0 });
    voice.setSpatialOptions!({ occlusion: false });
    expect([onCore.occlusionGain, onCore.occlusionLpHz, onCore.dopplerRate, onCore.velocity]).toEqual([0.25, 1000, 0.9, { x: 0, y: 3, z: 0 }]);
    expect(options).toEqual([{ dopplerLevel: 2, reverbSend: 0.5 }, { occlusion: false }]);
    voice.stop();
  });

  it("ADR 0162 (K4): a real voice without the M3 setters is handed over without them", () => {
    const pending = audioBackend();
    const voice = pending.play(loop())!;
    voice.setOcclusion!(0.5, 3000);
    voice.setVelocity!({ x: 1, y: 0, z: 0 });
    voice.setDopplerRate!(1.5);
    voice.setSpatialOptions!({ reverbSend: 0 });
    const core = makeFakeBackend();
    const play = core.play.bind(core);
    core.play = (req) => {
      const v = play(req)! as unknown as Record<string, unknown>;
      delete v.setOcclusion;
      delete v.setVelocity;
      delete v.setDopplerRate;
      return v as never;
    };
    undoCore = registerCoreBackend(() => core);
    expect(audioBackend()).toBe(core);
    expect(core.plays).toHaveLength(1);
    expect(() => voice.setOcclusion!(0.2, 100)).not.toThrow();
    expect(core.voices[0]!.events.some((e) => e.kind === "occlusion" || e.kind === "velocity" || e.kind === "doppler")).toBe(false);
    voice.stop();
  });
});
