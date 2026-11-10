import { describe, expect, it, vi } from "vitest";
import { ClipEvent, ClipFormat, Kind, readClipBegin } from "../wire.generated";
import { createClipRegistry } from "./clipRegistry";
import { HRIR_CLIP_ID, createHrirLoader, extractAverageGroupDelay, hrtfFftSize, readHrirHeader, resampleHrir, sincResample } from "./hrir";

const E = 10;
const A = 24;
const D = E * A;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** An asset at 44.1 kHz, 256 frames, delays in: an impulse of height 16384 at frame `at(d)` (default 50) in every response. */
function table(at: (d: number) => number = () => 50): ArrayBuffer {
  const len = 256;
  const buf = new ArrayBuffer(16 + 4 * D * len);
  const v = new DataView(buf);
  v.setUint32(0, E, true);
  v.setUint32(4, A, true);
  v.setUint32(8, len, true);
  v.setFloat32(12, 44100, true);
  for (let d = 0; d < D; d++) for (let ear = 0; ear < 2; ear++) v.setInt16(16 + d * len * 4 + (at(d) + ear) * 4 + ear * 2, 16384, true);
  return buf;
}

/** Response `d`, `ear` of a wire blob, as a fraction of full scale. */
function response(blob: ArrayBuffer, d: number, ear: number): Float32Array {
  const head = readHrirHeader(blob);
  const v = new DataView(blob);
  const base = 16 + 8 * D + d * head.irLength * 4 + ear * 2;
  return Float32Array.from({ length: head.irLength }, (_, j) => v.getInt16(base + j * 4, true) / 32768);
}

const peakAt = (x: Float32Array): number => x.reduce((best, s, i) => (Math.abs(s) > Math.abs(x[best]!) ? i : best), 0);

describe("hrtfFftSize (HRTFPanner::FftSizeForSampleRate)", () => {
  it("matches Chromium's table", () => {
    const want: [number, number][] = [[3000, 32], [8000, 64], [16000, 128], [22050, 256], [44100, 512], [48000, 512], [88200, 1024], [96000, 1024], [176400, 2048]];
    for (const [rate, size] of want) expect(hrtfFftSize(rate), `${rate}`).toBe(size);
  });
});

describe("sincResample (media::SincResampler as AudioBus::TryCreateBySampleRateConverting runs it)", () => {
  it("gives trunc(length / ratio) frames", () => {
    expect(sincResample(new Float32Array(256), 44100 / 48000).length).toBe(278);
    expect(sincResample(new Float32Array(256), 44100 / 96000).length).toBe(557);
    expect(sincResample(new Float32Array(256), 44100 / 22050).length).toBe(128);
  });

  it("passes DC and a 1 kHz sine at the new rate, with no delay (output j is the source at j * ratio)", () => {
    const ratio = 44100 / 48000;
    const dc = sincResample(new Float32Array(2048).fill(0.5), ratio);
    for (let j = 100; j < 2000; j++) expect(Math.abs(dc[j]! - 0.5)).toBeLessThan(2e-3);
    const sine = Float32Array.from({ length: 2048 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / 44100));
    const out = sincResample(sine, ratio);
    for (let j = 100; j < 2000; j++) expect(Math.abs(out[j]! - Math.sin((2 * Math.PI * 1000 * j) / 48000))).toBeLessThan(3e-3);
  });

  it("puts an impulse's peak at its position times the rate ratio, across the 64-frame request boundaries", () => {
    for (const at of [3, 50, 63, 64, 100, 200]) {
      const x = new Float32Array(256);
      x[at] = 1;
      expect(peakAt(sincResample(x, 44100 / 48000)), `impulse at ${at}`).toBe(Math.round((at * 48000) / 44100));
    }
  });
});

describe("extractAverageGroupDelay (HRTFKernel)", () => {
  it("gives about 29.34 frames for an impulse at 50 in 256, with the peak moved to 20 or 21", () => {
    const ir = new Float32Array(256);
    ir[50] = 1;
    expect(Math.abs(extractAverageGroupDelay(ir, 256) - 29.34)).toBeLessThan(0.1);
    expect([20, 21]).toContain(peakAt(ir));
  });

  it("leaves a silent response alone and returns 0", () => {
    const ir = new Float32Array(256);
    expect(extractAverageGroupDelay(ir, 256)).toBe(0);
    expect(ir.every((x) => x === 0)).toBe(true);
  });
});

describe("resampleHrir (the asset to the wire's format 2 at the context rate)", () => {
  it("at the asset's rate extracts each delay: 256 frames, the impulse moved to frame 20 or 21", () => {
    const out = resampleHrir(table(), 44100);
    expect(readHrirHeader(out)).toEqual({ elevations: E, azimuths: A, irLength: 256, rate: 44100 });
    expect(out.byteLength).toBe(16 + 8 * D + 4 * D * 256);
    const v = new DataView(out);
    expect(Math.abs(v.getFloat32(16 + 4 * 6, true) - 29.34)).toBeLessThan(0.1);
    expect([20, 21]).toContain(peakAt(response(out, 3, 0)));
  });

  it("at 48 kHz resamples with the delay in, then extracts it at 48 kHz: fft_size / 2 = 256 frames", () => {
    const at = (d: number) => 30 + (d % 50);
    const out = resampleHrir(table(at), 48000);
    const head = readHrirHeader(out);
    expect(head).toEqual({ elevations: E, azimuths: A, irLength: 256, rate: 48000 });
    expect(out.byteLength).toBe(16 + 8 * D + 4 * D * 256);
    const v = new DataView(out);
    for (const d of [0, 7, 49, 120]) {
      // The impulse lands at at(d) * 48000 / 44100; the extraction removes all but about 20 frames of it.
      const left = v.getFloat32(16 + d * 8, true);
      expect(Math.abs(left + 20 - (at(d) * 48000) / 44100), `direction ${d}`).toBeLessThan(1.5);
      expect(Math.abs(peakAt(response(out, d, 0)) - 20), `direction ${d}`).toBeLessThanOrEqual(1);
      // The right ear's impulse is a frame later at 44.1 kHz: its delay is longer by about 48000 / 44100.
      expect(Math.abs(v.getFloat32(16 + d * 8 + 4, true) - left - 48000 / 44100), `direction ${d}`).toBeLessThan(0.2);
    }
  });

  it("at 96 kHz gives 512 frames (fft_size 1024)", () => {
    expect(readHrirHeader(resampleHrir(table(), 96000)).irLength).toBe(512);
  });

  it("rejects a truncated asset, a blob with a delay table (the old layout, or the wire's) and a bad rate", () => {
    expect(() => resampleHrir(table().slice(0, 1000), 48000)).toThrow();
    const withTable = new Uint8Array(table().byteLength + 8 * D);
    withTable.set(new Uint8Array(table().slice(0, 16)));
    expect(() => resampleHrir(withTable.buffer, 48000)).toThrow();
    expect(() => resampleHrir(table(), 0)).toThrow();
    expect(() => resampleHrir(table(), Number.NaN)).toThrow();
  });
});

describe("hrir loader", () => {
  function harness(fetchBytes = vi.fn(async () => table())) {
    const sent: ArrayBuffer[] = [];
    const clips = createClipRegistry({ send: (m) => sent.push(m), nextQuantum: (cb) => void setTimeout(cb, 0), nextFrame: (cb) => void setTimeout(cb, 0) });
    const warn = vi.fn();
    const loader = createHrirLoader({ clips, sampleRate: 48000, fetchBytes, warn });
    return { clips, sent, loader, fetchBytes, warn };
  }

  it("fetches lazily on the first ensure() and only once", async () => {
    const h = harness();
    await settle();
    expect(h.fetchBytes).not.toHaveBeenCalled();
    h.loader.ensure();
    h.loader.ensure();
    await settle();
    expect(h.fetchBytes).toHaveBeenCalledTimes(1);
  });

  it("loads under the reserved id as format 2 at the context rate, and is ready only after clip event 4", async () => {
    const h = harness();
    h.loader.ensure();
    await settle();
    const kinds = () => h.sent.map((m) => new DataView(m).getUint16(6, true));
    expect(kinds()[0]).toBe(Kind.CLIP_BEGIN);
    const begin = readClipBegin(new DataView(h.sent[0]!), 0);
    expect(begin.clipId).toBe(HRIR_CLIP_ID);
    expect(begin.format).toBe(ClipFormat.HRIR);
    expect(begin.sampleRate).toBe(48000);
    expect(h.loader.ready).toBe(false);
    h.clips.applyClipEvent(HRIR_CLIP_ID, ClipEvent.HrtfReady);
    expect(h.loader.ready).toBe(true);
    expect(h.clips.residentIds()).toContain(HRIR_CLIP_ID);
  });

  it("A3.4c: retarget resamples the original table for a new context rate; the rebuild's resend carries it", async () => {
    const h = harness();
    h.loader.ensure();
    await settle();
    h.clips.applyClipEvent(HRIR_CLIP_ID, ClipEvent.HrtfReady);
    h.sent.length = 0;
    // A context at 44.1 kHz: the table is made again from the original asset for that rate.
    h.loader.retarget!(44100);
    expect(h.sent).toHaveLength(0);
    h.clips.resend!([]);
    await settle();
    const begin = readClipBegin(new DataView(h.sent[0]!), 0);
    expect(begin.clipId).toBe(HRIR_CLIP_ID);
    expect(begin.sampleRate).toBe(44100);
    expect(begin.frames).toBe(resampleHrir(table(), 44100).byteLength / 2);
    expect(h.loader.ready).toBe(false);
    h.clips.applyClipEvent(HRIR_CLIP_ID, ClipEvent.HrtfReady);
    expect(h.loader.ready).toBe(true);
    // And to 96 kHz from the same original.
    h.sent.length = 0;
    h.loader.retarget!(96000);
    h.clips.resend!([]);
    await settle();
    const again = readClipBegin(new DataView(h.sent[0]!), 0);
    expect(again.sampleRate).toBe(96000);
    expect(again.frames).toBe(resampleHrir(table(), 96000).byteLength / 2);
  });

  it("warns once and stays not ready when the fetch fails", async () => {
    const h = harness(vi.fn(async () => Promise.reject(new Error("HTTP 404"))));
    h.loader.ensure();
    await settle();
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.loader.ready).toBe(false);
    expect(h.sent).toHaveLength(0);
  });
});
