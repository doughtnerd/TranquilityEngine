// A0.6: the feature probes and the one-warning fallback (ADR 0157 Platforms; architecture §2.1, §7).
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { audioBackend, mixer, registerDefaultBackend, setAudioBackend, type AudioBackend } from "../backend";
import { probeCoreSupport, type ProbeEnv } from "./probe";
import { defaultBackend, parseAudioSettings } from "../../../../engine/audio/settings";
import { endAudioSession, makeFakeBackend } from "../testing";
import { Audio } from "../index";

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
  status: "running", time: 0, debug: () => ({}) as never, setBackground() {}, update() {}, dispose() {},
});

const FEATURES = ["AudioWorklet", "WebAssembly simd128", "AudioContext.getOutputTimestamp", "transferable ArrayBuffers"];

/** The refusal a probe of `env` gives: null when supported. */
async function refusal(env: ProbeEnv): Promise<string | null> {
  const result = await probeCoreSupport(env);
  return result.supported ? null : result.reason;
}

/** The features a probe of `env` names as missing, in the refusal's order (empty when supported). */
async function missingFeatures(env: ProbeEnv): Promise<string[]> {
  const reason = await refusal(env);
  return reason === null ? [] : /lacks (.*)\. The core needs/.exec(reason)![1]!.split(", ");
}

describe("the missing features a probe names", () => {
  afterEach(() => endAudioSession());
  it("is empty for a full engine (AudioContext with getOutputTimestamp, AudioWorkletNode, simd wasm, MessageChannel)", async () => {
    expect(await missingFeatures(fullEnv())).toEqual([]);
  });
  it("names AudioWorklet when AudioWorkletNode is missing", async () => {
    expect(await missingFeatures({ ...fullEnv(), AudioWorkletNode: undefined })).toEqual(["AudioWorklet"]);
  });
  it("names WebAssembly simd128 when WebAssembly.validate rejects the simd128 probe module or WebAssembly is missing", async () => {
    const validate = vi.fn(() => false);
    expect(await missingFeatures({ ...fullEnv(), WebAssembly: { validate } })).toEqual(["WebAssembly simd128"]);
    expect(validate).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(await missingFeatures({ ...fullEnv(), WebAssembly: { validate: () => { throw new Error("no wasm"); } } })).toEqual(["WebAssembly simd128"]);
    expect(await missingFeatures({ ...fullEnv(), WebAssembly: undefined })).toEqual(["WebAssembly simd128"]);
  });
  it("names getOutputTimestamp when AudioContext.prototype lacks it", async () => {
    expect(await missingFeatures({ ...fullEnv(), AudioContext: { prototype: {} } })).toEqual(["AudioContext.getOutputTimestamp"]);
    expect(await missingFeatures({ ...fullEnv(), AudioContext: undefined })).toEqual(["AudioContext.getOutputTimestamp"]);
  });
  it("names transferable ArrayBuffers when MessageChannel is missing", async () => {
    expect(await missingFeatures({ ...fullEnv(), MessageChannel: undefined })).toEqual(["transferable ArrayBuffers"]);
  });
  it("lists every missing feature, in a fixed order", async () => {
    expect(await missingFeatures(oldEngine())).toEqual(FEATURES);
    expect(await missingFeatures({ ...fullEnv(), MessageChannel: undefined, AudioWorkletNode: undefined })).toEqual([
      "AudioWorklet", "transferable ArrayBuffers",
    ]);
  });
});

describe("the refusal", () => {
  afterEach(() => endAudioSession());
  it("names the missing features, the minimum versions and the fallback to babylon", async () => {
    const msg = (await refusal(oldEngine()))!;
    for (const name of FEATURES) expect(msg).toContain(name);
    expect(msg).toContain("Chrome/Edge 66");
    expect(msg).toContain("Safari 16.4");
    expect(msg).toContain(`"babylon"`);
    expect(msg).toContain("https://github.com/doughtnerd/TranquilityEngine/wiki/Audio-core-minimum-browser-and-webview-versions");
  });
});

describe("probeCoreSupport on a stubbed old engine", () => {
  let warn: MockInstance<(...data: unknown[]) => void>;
  let savedBackend: typeof mixer.audioSettings.backend;

  beforeEach(() => {
    endAudioSession();
    setAudioBackend(null);
    savedBackend = mixer.audioSettings.backend;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    mixer.audioSettings.backend = savedBackend;
    setAudioBackend(null);
    endAudioSession();
  });

  it("returns supported on a full engine and logs nothing", async () => {
    expect(await probeCoreSupport(fullEnv())).toEqual({ supported: true });
    expect(warn).not.toHaveBeenCalled();
  });
  it("returns unsupported with the reason, then audioBackend() logs exactly one warning containing it and uses the babylon factory", async () => {
    const result = await probeCoreSupport(oldEngine());
    if (result.supported) throw new Error("an old engine must be unsupported");
    expect(result.reason).toContain(`lacks ${FEATURES.join(", ")}.`);
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
    expect(warn).toHaveBeenCalledWith(`[myco] ${(await refusal(oldEngine()))!}`);
  });
  it("a released audio session lets the next refusal warn again", async () => {
    const make = vi.fn(() => fakeBackend("babylon"));
    registerDefaultBackend(make);
    mixer.audioSettings.backend = "core";
    await probeCoreSupport(oldEngine());
    audioBackend();
    setAudioBackend(null);
    endAudioSession();
    await probeCoreSupport(oldEngine());
    audioBackend();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.lastCall?.[0])).toContain(`[myco] Audio core unavailable: this engine lacks ${FEATURES.join(", ")}.`);
  });
  it("with the default backend (no audio.backend in the project) an old engine still gives one warning and falls back to babylon", async () => {
    const make = vi.fn(() => fakeBackend("babylon"));
    registerDefaultBackend(make);
    mixer.audioSettings.backend = parseAudioSettings({}).settings.backend;
    expect(mixer.audioSettings.backend).toBe(defaultBackend());
    await probeCoreSupport(oldEngine());
    expect(audioBackend().name).toBe("babylon");
    setAudioBackend(null);
    expect(audioBackend().name).toBe("babylon");
    expect(make).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[myco] ${(await refusal(oldEngine()))!}`);
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

describe("Audio.debug().coreUnavailable (ADR 0341)", () => {
  beforeEach(() => {
    endAudioSession();
    setAudioBackend(makeFakeBackend());
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setAudioBackend(null);
    endAudioSession();
  });

  it("is absent until the engine says why the core can't run", () => {
    expect(Audio.debug().coreUnavailable).toBeUndefined();
  });

  it("carries the probe's refusal, and a released session forgets it", async () => {
    await probeCoreSupport(oldEngine());
    expect(Audio.debug().coreUnavailable).toMatch(/lacks AudioWorklet, WebAssembly simd128/);
    endAudioSession();
    expect(Audio.debug().coreUnavailable).toBeUndefined();
  });
});
