// A0.6: the feature probes and the one-warning fallback (ADR 0157 Platforms; architecture §2.1, §7).
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { audioBackend, mixer, registerDefaultBackend, resetCoreFallbackState, setAudioBackend, type AudioBackend } from "../backend";
import { missingFeatures, probeCoreSupport, refusalMessage, SIMD_PROBE_MODULE, type ProbeEnv } from "./probe";

/** A full engine: every probe passes. Built fresh each call, so no test shares or mutates a stub. */
const fullEnv = (): ProbeEnv => ({
  AudioContext: { prototype: { getOutputTimestamp() {} } },
  AudioWorkletNode: class {},
  WebAssembly: { validate: () => true },
  MessageChannel: class {},
});
/** An old engine: nothing the core needs is there. */
const oldEngine = (): ProbeEnv => ({});

const fakeBackend = (name: string): AudioBackend => ({
  name, play: () => null, setListener() {}, applyMix() {}, configureBuses() {}, masterVolume: 1, muted: false,
});

const FEATURES = ["AudioWorklet", "WebAssembly simd128", "AudioContext.getOutputTimestamp", "transferable ArrayBuffers"];

describe("missingFeatures", () => {
  it("is empty for a full engine (AudioContext with getOutputTimestamp, AudioWorkletNode, simd wasm, MessageChannel)", () => {
    expect(missingFeatures(fullEnv())).toEqual([]);
  });
  it("names AudioWorklet when AudioWorkletNode is missing", () => {
    expect(missingFeatures({ ...fullEnv(), AudioWorkletNode: undefined })).toEqual(["AudioWorklet"]);
  });
  it("names WebAssembly simd128 when WebAssembly.validate rejects SIMD_PROBE_MODULE or WebAssembly is missing", () => {
    const validate = vi.fn(() => false);
    expect(missingFeatures({ ...fullEnv(), WebAssembly: { validate } })).toEqual(["WebAssembly simd128"]);
    expect(validate).toHaveBeenCalledWith(SIMD_PROBE_MODULE);
    expect(missingFeatures({ ...fullEnv(), WebAssembly: { validate: () => { throw new Error("no wasm"); } } })).toEqual(["WebAssembly simd128"]);
    expect(missingFeatures({ ...fullEnv(), WebAssembly: undefined })).toEqual(["WebAssembly simd128"]);
  });
  it("names getOutputTimestamp when AudioContext.prototype lacks it", () => {
    expect(missingFeatures({ ...fullEnv(), AudioContext: { prototype: {} } })).toEqual(["AudioContext.getOutputTimestamp"]);
    expect(missingFeatures({ ...fullEnv(), AudioContext: undefined })).toEqual(["AudioContext.getOutputTimestamp"]);
  });
  it("names transferable ArrayBuffers when MessageChannel is missing", () => {
    expect(missingFeatures({ ...fullEnv(), MessageChannel: undefined })).toEqual(["transferable ArrayBuffers"]);
  });
  it("lists every missing feature, in a fixed order", () => {
    expect(missingFeatures(oldEngine())).toEqual(FEATURES);
    expect(missingFeatures({ ...fullEnv(), MessageChannel: undefined, AudioWorkletNode: undefined })).toEqual([
      "AudioWorklet", "transferable ArrayBuffers",
    ]);
  });
});

describe("refusalMessage", () => {
  it("names the missing features, the minimum versions and the fallback to babylon", () => {
    const msg = refusalMessage(FEATURES);
    for (const name of FEATURES) expect(msg).toContain(name);
    expect(msg).toContain("Chrome/Edge 66");
    expect(msg).toContain("Safari 16.4");
    expect(msg).toContain(`"babylon"`);
    expect(msg).toContain("docs/guide/audio-minimum-versions.md");
  });
});

describe("probeCoreSupport on a stubbed old engine", () => {
  let warn: MockInstance<(...data: unknown[]) => void>;
  let savedBackend: typeof mixer.audioSettings.backend;

  beforeEach(() => {
    resetCoreFallbackState();
    setAudioBackend(null);
    savedBackend = mixer.audioSettings.backend;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    mixer.audioSettings.backend = savedBackend;
    setAudioBackend(null);
    resetCoreFallbackState();
  });

  it("returns supported on a full engine and logs nothing", async () => {
    expect(await probeCoreSupport(fullEnv())).toEqual({ supported: true });
    expect(warn).not.toHaveBeenCalled();
  });
  it("returns unsupported with the reason, then audioBackend() logs exactly one warning containing it and uses the babylon factory", async () => {
    const result = await probeCoreSupport(oldEngine());
    if (result.supported) throw new Error("an old engine must be unsupported");
    expect(result.reason).toBe(refusalMessage(FEATURES));
    const make = vi.fn(() => fakeBackend("babylon"));
    registerDefaultBackend(make);
    mixer.audioSettings.backend = "core";
    expect(audioBackend().name).toBe("babylon");
    expect(make).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[myco] ${result.reason}`);
  });
  it("repeated audioBackend() creations and repeated probes still log one warning", async () => {
    const make = vi.fn(() => fakeBackend("babylon"));
    registerDefaultBackend(make);
    mixer.audioSettings.backend = "core";
    await probeCoreSupport(oldEngine());
    await probeCoreSupport(oldEngine());
    audioBackend();
    setAudioBackend(null);
    await probeCoreSupport(oldEngine());
    audioBackend();
    setAudioBackend(null);
    audioBackend();
    expect(make).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[myco] ${refusalMessage(FEATURES)}`);
  });
  it("resetCoreFallbackState() lets the next refusal warn again", async () => {
    const make = vi.fn(() => fakeBackend("babylon"));
    registerDefaultBackend(make);
    mixer.audioSettings.backend = "core";
    await probeCoreSupport(oldEngine());
    audioBackend();
    setAudioBackend(null);
    resetCoreFallbackState();
    await probeCoreSupport(oldEngine());
    audioBackend();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(`[myco] ${refusalMessage(FEATURES)}`);
  });
  it("logs nothing when audio.backend is babylon, even on an old engine", async () => {
    const make = vi.fn(() => fakeBackend("babylon"));
    registerDefaultBackend(make);
    mixer.audioSettings.backend = "babylon";
    await probeCoreSupport(oldEngine());
    expect(audioBackend().name).toBe("babylon");
    expect(make).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
