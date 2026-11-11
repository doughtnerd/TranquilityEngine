// ADR 0162 A3 (leaf L-A3a): the MagLS asset's format 4 loader in hrir.ts (`resampleMagls`, `createMaglsLoader`).
import { describe, expect, it, vi } from "vitest";
import {
  ClipEvent,
  ClipFormat,
  Kind,
  MAGLS_CLIP_ID,
  MAGLS_MAGIC,
  MAGLS_ORDER,
  MAGLS_VERSION,
  readClipBegin,
  readClipChunk,
  readMaglsHeader,
  writeMaglsHeader,
} from "../wire.generated";
import { createClipRegistry } from "./clipRegistry";
import { createMaglsLoader, resampleMagls } from "./hrir";

const RESPONSES = 32;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Lets the paced CLIP_CHUNKs go out. */
const pump = async () => {
  for (let i = 0; i < 20; i++) await settle();
};

/** A MagLS asset at `rate` with `taps` per response; `fill(response, frame)` gives each sample. */
function build(
  taps: number,
  rate: number,
  fill: (r: number, i: number) => number = () => 0,
  over: { magic?: number; version?: number; order?: number; extra?: number } = {},
): ArrayBuffer {
  const buf = new ArrayBuffer(32 + (over.extra ?? 0) + RESPONSES * taps * 4);
  writeMaglsHeader(new DataView(buf), 0, {
    magic: over.magic ?? MAGLS_MAGIC,
    version: over.version ?? MAGLS_VERSION,
    order: over.order ?? MAGLS_ORDER,
    taps,
    sampleRate: rate,
    reserved: [0, 0, 0],
  });
  const v = new DataView(buf);
  for (let r = 0; r < RESPONSES; r++) for (let i = 0; i < taps; i++) v.setFloat32(32 + (r * taps + i) * 4, fill(r, i), true);
  return buf;
}

/** One impulse of height 0.5 per response, at frame `at(r)` (default 50) of a 256-tap 44.1 kHz asset. */
const impulses = (at: (r: number) => number = () => 50) => (r: number, i: number) => (i === at(r) ? 0.5 : 0);
const asset44 = () => build(256, 44100, impulses());

/** Response `r` of a format 4 blob with `taps` per response. */
function response(blob: ArrayBuffer, taps: number, r: number): Float32Array {
  const v = new DataView(blob);
  return Float32Array.from({ length: taps }, (_, i) => v.getFloat32(32 + (r * taps + i) * 4, true));
}

const peakAt = (x: Float32Array): number => x.reduce((best, s, i) => (Math.abs(s) > Math.abs(x[best]!) ? i : best), 0);

describe("resampleMagls (format 4 for the context rate)", () => {
  it("returns a blob equal to the asset at the asset's own rate (44.1 kHz)", () => {
    const a = asset44();
    const out = resampleMagls(a, 44100);
    expect(out.byteLength).toBe(a.byteLength);
    expect(new Uint8Array(out)).toEqual(new Uint8Array(a));
  });

  it("at 48 kHz: 256 taps, header rate 48000, an impulse at frame k peaks at round(k * 48000 / 44100)", () => {
    const out = resampleMagls(asset44(), 48000);
    expect(readMaglsHeader(new DataView(out), 0)).toEqual({ magic: MAGLS_MAGIC, version: MAGLS_VERSION, order: MAGLS_ORDER, taps: 256, sampleRate: 48000, reserved: [0, 0, 0] });
    expect(out.byteLength).toBe(32 + RESPONSES * 256 * 4);
    for (const r of [0, 7, 31]) expect(peakAt(response(out, 256, r)), `response ${r}`).toBe(Math.round((50 * 48000) / 44100));
  });

  it("at 96 kHz: 512 taps (MAGLS_TAPS_HIGH_RATE); at 22.05 kHz: 128 taps", () => {
    const high = resampleMagls(asset44(), 96000);
    expect(readMaglsHeader(new DataView(high), 0).taps).toBe(512);
    expect(high.byteLength).toBe(32 + RESPONSES * 512 * 4);
    expect(peakAt(response(high, 512, 0))).toBe(Math.round((50 * 96000) / 44100));
    const low = resampleMagls(asset44(), 22050);
    expect(readMaglsHeader(new DataView(low), 0).taps).toBe(128);
    expect(low.byteLength).toBe(32 + RESPONSES * 128 * 4);
    expect(peakAt(response(low, 128, 0))).toBe(25);
  });

  it("cuts a response longer than taps with a linear fade over its last trunc(rate / 4410) frames", () => {
    // A DC response at 48 kHz resamples to 278 frames; the cut to 256 fades the last trunc(48000 / 4410) = 10 frames.
    const out = resampleMagls(build(256, 44100, () => 0.5), 48000);
    const r = response(out, 256, 3);
    for (let i = 100; i < 246; i++) expect(Math.abs(r[i]! - 0.5), `frame ${i}`).toBeLessThan(3e-3);
    for (let i = 246; i < 256; i++) expect(Math.abs(r[i]! - 0.5 * (1 - (i - 246) / 10)), `frame ${i}`).toBeLessThan(3e-3);
  });

  it("keeps the asset's response order [16 channels][2 ears]", () => {
    const at = (r: number) => 10 + r;
    const out = resampleMagls(build(256, 44100, impulses(at)), 48000);
    for (let r = 0; r < RESPONSES; r++) expect(peakAt(response(out, 256, r)), `response ${r}`).toBe(Math.round((at(r) * 48000) / 44100));
  });

  it("throws on a bad magic, version, order, byte length or asset rate, and on a bad target rate", () => {
    expect(() => resampleMagls(build(256, 44100, undefined, { magic: 0 }), 48000)).toThrow();
    expect(() => resampleMagls(build(256, 44100, undefined, { version: 2 }), 48000)).toThrow();
    expect(() => resampleMagls(build(256, 44100, undefined, { order: 2 }), 48000)).toThrow();
    expect(() => resampleMagls(build(256, 44100, undefined, { extra: 4 }), 48000)).toThrow();
    expect(() => resampleMagls(asset44().slice(0, -4), 48000)).toThrow();
    expect(() => resampleMagls(new ArrayBuffer(16), 48000)).toThrow();
    expect(() => resampleMagls(build(256, 0), 48000)).toThrow();
    expect(() => resampleMagls(build(256, Number.NaN), 48000)).toThrow();
    expect(() => resampleMagls(build(0, 44100), 48000)).toThrow();
    for (const bad of [0, -48000, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => resampleMagls(asset44(), bad), `${bad}`).toThrow();
  });
});

describe("createMaglsLoader", () => {
  function harness(fetchBytes = vi.fn(async () => asset44())) {
    const sent: ArrayBuffer[] = [];
    const clips = createClipRegistry({ send: (m) => sent.push(m), nextQuantum: (cb) => void setTimeout(cb, 0), nextFrame: (cb) => void setTimeout(cb, 0) });
    const warn = vi.fn();
    const loader = createMaglsLoader({ clips, sampleRate: 48000, fetchBytes, warn });
    return { clips, sent, loader, fetchBytes, warn };
  }

  it("does nothing until ensure (started false, no fetch)", async () => {
    const h = harness();
    await settle();
    expect(h.loader.started).toBe(false);
    expect(h.fetchBytes).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
    expect(h.loader.ready).toBe(false);
    expect(h.loader.failed).toBe(false);
  });

  it("ensure fetches once and sends CLIP_BEGIN format 4, id 0xFFFF0100, channels 1, frames = bytes / 4, the MYBD header first", async () => {
    const h = harness();
    h.loader.ensure();
    h.loader.ensure();
    await pump();
    expect(h.fetchBytes).toHaveBeenCalledTimes(1);
    expect(h.loader.started).toBe(true);
    const blob = resampleMagls(asset44(), 48000);
    expect(readClipBegin(new DataView(h.sent[0]!), 0)).toEqual({ clipId: MAGLS_CLIP_ID, frames: blob.byteLength / 4, channels: 1, sampleRate: 48000, format: ClipFormat.MagLS });
    // The paced chunks carry the blob in order; the first begins with the MYBD header.
    const chunks = h.sent.filter((m) => new DataView(m).getUint16(6, true) === Kind.CLIP_CHUNK);
    expect(chunks.length).toBeGreaterThan(0);
    const bytes = new Uint8Array(blob.byteLength);
    let at = 0;
    for (const m of chunks) {
      const c = readClipChunk(new DataView(m), 0);
      expect(c.frameOffset * 4).toBe(at);
      bytes.set(new Uint8Array(m, 32, c.frames * 4), at);
      at += c.frames * 4;
    }
    expect(at).toBe(blob.byteLength);
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(MAGLS_MAGIC);
    expect(bytes).toEqual(new Uint8Array(blob));
  });

  it("ready follows the core's resident clip event for 0xFFFF0100", async () => {
    const h = harness();
    h.loader.ensure();
    await pump();
    expect(h.loader.ready).toBe(false);
    h.clips.applyClipEvent(MAGLS_CLIP_ID, ClipEvent.Resident);
    expect(h.loader.ready).toBe(true);
    expect(h.clips.residentIds()).toContain(MAGLS_CLIP_ID);
  });

  it("a failed fetch warns once, sets failed and is not retried", async () => {
    const h = harness(vi.fn(async () => Promise.reject(new Error("HTTP 404"))));
    h.loader.ensure();
    await pump();
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0]![0]).toBe("audio: the MagLS bed filters failed to load, beds decode through the equal-power matrix (HTTP 404)");
    expect(h.loader.failed).toBe(true);
    expect(h.loader.ready).toBe(false);
    expect(h.sent).toHaveLength(0);
    h.loader.ensure();
    await pump();
    expect(h.fetchBytes).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it("retarget resamples into the registry's kept blob, so a rebuild's resend carries the new rate's taps", async () => {
    const h = harness();
    h.loader.ensure();
    await pump();
    h.clips.applyClipEvent(MAGLS_CLIP_ID, ClipEvent.Resident);
    h.sent.length = 0;
    // 44.1 kHz: the blob is the asset again (256 taps); nothing is sent until the rebuild's resend.
    h.loader.retarget!(44100);
    expect(h.sent).toHaveLength(0);
    h.clips.resend!([]);
    await pump();
    const at441 = readClipBegin(new DataView(h.sent[0]!), 0);
    expect(at441).toEqual({ clipId: MAGLS_CLIP_ID, frames: asset44().byteLength / 4, channels: 1, sampleRate: 44100, format: ClipFormat.MagLS });
    h.clips.applyClipEvent(MAGLS_CLIP_ID, ClipEvent.Resident);
    // 96 kHz: 512 taps.
    h.sent.length = 0;
    h.loader.retarget!(96000);
    h.clips.resend!([]);
    await pump();
    const at96 = readClipBegin(new DataView(h.sent[0]!), 0);
    expect(at96.sampleRate).toBe(96000);
    expect(at96.frames).toBe(resampleMagls(asset44(), 96000).byteLength / 4);
    expect(at96.frames).toBe((32 + RESPONSES * 512 * 4) / 4);
  });
});

describe("the committed magls-o3.bin (made by native/audio/tools/bake-magls)", () => {
  const load = async (): Promise<ArrayBuffer> => {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(new URL("../../../../engine/audio/magls-o3.bin", import.meta.url));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  };

  it("is 32,800 B: the MYBD header (version 1, order 3, 256 taps, 44.1 kHz) then finite responses", async () => {
    const asset = await load();
    expect(asset.byteLength).toBe(32_800);
    const head = readMaglsHeader(new DataView(asset), 0);
    expect(head).toEqual({ magic: MAGLS_MAGIC, version: MAGLS_VERSION, order: MAGLS_ORDER, taps: 256, sampleRate: 44100, reserved: [0, 0, 0] });
    const samples = new Float32Array(asset, 32);
    expect(samples.every(Number.isFinite)).toBe(true);
    expect(Math.max(...samples.map(Math.abs))).toBeGreaterThan(0.01);
  });

  it("loads unchanged at 44.1 kHz and resamples to 256 taps at 48 kHz and 512 at 96 kHz", async () => {
    const asset = await load();
    expect(new Uint8Array(resampleMagls(asset, 44100))).toEqual(new Uint8Array(asset));
    for (const [rate, taps] of [[48000, 256], [96000, 512]] as const) {
      const blob = resampleMagls(asset, rate);
      expect(readMaglsHeader(new DataView(blob), 0)).toMatchObject({ taps, sampleRate: rate });
      expect(blob.byteLength).toBe(32 + 32 * taps * 4);
      // The W channel's left response keeps its energy within 1 dB (Chromium resamples HRIRs without a gain change, so
      // the sum of squares scales with the rate ratio).
      const energy = (b: ArrayBuffer, n: number) => new Float32Array(b, 32, n).reduce((s, x) => s + x * x, 0);
      const ratio = energy(blob, taps) / energy(asset, 256) / (rate / 44100);
      expect(Math.abs(10 * Math.log10(ratio))).toBeLessThan(1);
    }
  });
});
