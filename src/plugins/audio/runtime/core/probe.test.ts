// A0.6: the feature probes and the one-warning fallback (ADR 0157 Platforms; architecture §2.1, §7).
import { describe, it } from "vitest";

describe("missingFeatures", () => {
  it.todo("is empty for a full engine (AudioContext with getOutputTimestamp, AudioWorkletNode, simd wasm, MessageChannel)");
  it.todo("names AudioWorklet when AudioWorkletNode is missing");
  it.todo("names WebAssembly simd128 when WebAssembly.validate rejects SIMD_PROBE_MODULE or WebAssembly is missing");
  it.todo("names getOutputTimestamp when AudioContext.prototype lacks it");
  it.todo("names transferable ArrayBuffers when MessageChannel is missing");
  it.todo("lists every missing feature, in a fixed order");
});

describe("refusalMessage", () => {
  it.todo("names the missing features, the minimum versions and the fallback to babylon");
});

describe("probeCoreSupport on a stubbed old engine", () => {
  it.todo("returns supported on a full engine and logs nothing");
  it.todo("returns unsupported with the reason, then audioBackend() logs exactly one warning containing it and uses the babylon factory");
  it.todo("repeated audioBackend() creations and repeated probes still log one warning");
});
