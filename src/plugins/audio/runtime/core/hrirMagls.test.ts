// ADR 0162 A3 (leaf L-A3a): the MagLS asset's format 4 loader in hrir.ts (`resampleMagls`, `createMaglsLoader`).
import { describe, it } from "vitest";

describe("resampleMagls (format 4 for the context rate)", () => {
  it.skip("returns a blob equal to the asset at the asset's own rate (44.1 kHz)", () => {});
  it.skip("at 48 kHz: 256 taps, header rate 48000, an impulse at frame k peaks at round(k * 48000 / 44100)", () => {});
  it.skip("at 96 kHz: 512 taps (MAGLS_TAPS_HIGH_RATE); at 22.05 kHz: 128 taps", () => {});
  it.skip("cuts a response longer than taps with a linear fade over its last trunc(rate / 4410) frames", () => {});
  it.skip("keeps the asset's response order [16 channels][2 ears]", () => {});
  it.skip("throws on a bad magic, version, order, byte length or asset rate, and on a bad target rate", () => {});
});

describe("createMaglsLoader", () => {
  it.skip("does nothing until ensure (started false, no fetch)", () => {});
  it.skip("ensure fetches once and sends CLIP_BEGIN format 4, id 0xFFFF0100, channels 1, frames = bytes / 4, the MYBD header first", () => {});
  it.skip("ready follows the core's resident clip event for 0xFFFF0100", () => {});
  it.skip("a failed fetch warns once, sets failed and is not retried", () => {});
  it.skip("retarget resamples into the registry's kept blob, so a rebuild's resend carries the new rate's taps", () => {});
});
