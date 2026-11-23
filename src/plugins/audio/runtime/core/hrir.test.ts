import { describe, expect, it, vi } from "vitest";
import { ClipEvent, ClipFormat, Kind, readClipBegin } from "../wire.generated";
import { createClipRegistry } from "./clipRegistry";
import { createHrirLoader, type SpatialPrepare } from "./hrir";
import { HRIR_CLIP_ID_FIRST as HRIR_CLIP_ID } from "../wire.generated";
import { inProcessSpatialPrepare } from "../testing";

// The HRIR loader (H2, H5) and the format 2 table the decoder prepares for it (ADR 0331: `myco_hrir_prepare`, here on the
// committed decoder wasm in process; its resampler and group-delay extraction have their unit tests in audio-decode's
// spatial.rs, and tests/spatial.rs pins the committed asset's blobs).

const prepare = inProcessSpatialPrepare();
const prepareHrir = (asset: ArrayBuffer, rate: number) => prepare("hrir", asset, rate);

/** The 16-byte header of the asset and of the format 2 blob. */
function readHrirHeader(blob: ArrayBuffer) {
  const v = new DataView(blob);
  return { elevations: v.getUint32(0, true), azimuths: v.getUint32(4, true), irLength: v.getUint32(8, true), rate: v.getFloat32(12, true) };
}

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

describe("myco_hrir_prepare (the asset to the wire's format 2 at the context rate)", () => {
  it("at the asset's rate extracts each delay: 256 frames, the impulse moved to frame 20 or 21", async () => {
    const out = await prepareHrir(table(), 44100);
    expect(readHrirHeader(out)).toEqual({ elevations: E, azimuths: A, irLength: 256, rate: 44100 });
    expect(out.byteLength).toBe(16 + 8 * D + 4 * D * 256);
    const v = new DataView(out);
    expect(Math.abs(v.getFloat32(16 + 4 * 6, true) - 29.34)).toBeLessThan(0.1);
    expect([20, 21]).toContain(peakAt(response(out, 3, 0)));
  });

  it("at 48 kHz resamples with the delay in, then extracts it at 48 kHz: fft_size / 2 = 256 frames", async () => {
    const at = (d: number) => 30 + (d % 50);
    const out = await prepareHrir(table(at), 48000);
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

  it("at 96 kHz gives 512 frames (fft_size 1024)", async () => {
    expect(readHrirHeader(await prepareHrir(table(), 96000)).irLength).toBe(512);
  });

  it("rejects a truncated asset, a blob with a delay table (the old layout, or the wire's) and a bad rate", async () => {
    await expect(prepareHrir(table().slice(0, 1000), 48000)).rejects.toMatchObject({ code: -3 });
    const withTable = new Uint8Array(table().byteLength + 8 * D);
    withTable.set(new Uint8Array(table().slice(0, 16)));
    await expect(prepareHrir(withTable.buffer, 48000)).rejects.toMatchObject({ code: -3 });
    await expect(prepareHrir(table(), 0)).rejects.toMatchObject({ code: -2 });
    await expect(prepareHrir(table(), Number.NaN)).rejects.toMatchObject({ code: -2 });
  });
});

describe("hrir loader", () => {
  function harness(fetchBytes = vi.fn(async () => table()), prep: SpatialPrepare = prepare) {
    const sent: ArrayBuffer[] = [];
    const clips = createClipRegistry({ send: (m) => sent.push(m), nextQuantum: (cb) => void setTimeout(cb, 0), nextFrame: (cb) => void setTimeout(cb, 0) });
    const warn = vi.fn();
    const loader = createHrirLoader({ clips, sampleRate: 48000, fetchBytes, prepare: prep, warn });
    return { clips, sent, loader, fetchBytes, warn };
  }

  /** A preparation the test releases by hand: each call waits until `release()`; `fail` makes the next calls reject. */
  function gated() {
    const waiting: (() => void)[] = [];
    const state = { fail: false, calls: [] as number[] };
    const prep: SpatialPrepare = async (kind, asset, rate) => {
      state.calls.push(rate);
      await new Promise<void>((resolve) => waiting.push(resolve));
      if (state.fail) throw new Error("the decoder refused it");
      return prepare(kind, asset, rate);
    };
    const release = async () => {
      for (let i = 0; i < 5; i++) await settle(); // the fetch, then the call that waits here
      for (const go of waiting.splice(0)) go();
      for (let i = 0; i < 5; i++) await settle();
    };
    return { prep, release, state };
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

  it("A3.4c: retarget prepares the original table for a new context rate; the rebuild's resend carries it", async () => {
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
    expect(begin.frames).toBe((await prepareHrir(table(), 44100)).byteLength / 2);
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
    expect(again.frames).toBe((await prepareHrir(table(), 96000)).byteLength / 2);
  });

  it("A3.4c: a resend while the new rate's table is still being prepared sends nothing for it; the table begins when it lands", async () => {
    const g = gated();
    const h = harness(undefined, g.prep);
    h.loader.ensure();
    await g.release();
    h.clips.applyClipEvent(HRIR_CLIP_ID, ClipEvent.HrtfReady);
    h.sent.length = 0;
    h.loader.retarget!(44100);
    h.clips.resend!([]);
    await settle();
    // The old (48 kHz) table would be refused by a 44.1 kHz core: nothing goes until the new one lands.
    expect(h.sent).toHaveLength(0);
    expect(h.loader.ready).toBe(false);
    await g.release();
    const begin = readClipBegin(new DataView(h.sent[0]!), 0);
    expect(begin).toMatchObject({ clipId: HRIR_CLIP_ID, sampleRate: 44100 });
    h.clips.applyClipEvent(HRIR_CLIP_ID, ClipEvent.HrtfReady);
    expect(h.loader.ready).toBe(true);
  });

  it("a retarget while the first preparation runs prepares again for the new rate", async () => {
    const g = gated();
    const h = harness(undefined, g.prep);
    h.loader.ensure();
    await settle();
    h.loader.retarget!(96000);
    await g.release(); // the 48 kHz table lands, is stale, and a 96 kHz one is asked for
    await g.release();
    expect(g.state.calls).toEqual([48000, 96000]);
    expect(readClipBegin(new DataView(h.sent[0]!), 0).sampleRate).toBe(96000);
  });

  it("a retarget whose preparation fails warns once and leaves the table failed: the resend sends nothing", async () => {
    const g = gated();
    const h = harness(undefined, g.prep);
    h.loader.ensure();
    await g.release();
    h.clips.applyClipEvent(HRIR_CLIP_ID, ClipEvent.HrtfReady);
    h.sent.length = 0;
    g.state.fail = true;
    h.loader.retarget!(44100);
    h.clips.resend!([]);
    await g.release();
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0]![0]).toBe("audio: the HRTF data failed to load, spatial voices stay equal-power (the decoder refused it)");
    expect(h.clips.state(HRIR_CLIP_ID)).toBe("failed");
    expect(h.loader.ready).toBe(false);
    expect(h.sent).toHaveLength(0);
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
