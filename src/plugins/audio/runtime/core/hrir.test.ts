import { describe, expect, it, vi } from "vitest";
import { ClipEvent, ClipFormat, Kind, readClipBegin } from "../wire.generated";
import { createClipRegistry } from "./clipRegistry";
import { HRIR_CLIP_ID, createHrirLoader, readHrirHeader, resampleHrir } from "./hrir";

const E = 10;
const A = 24;
const D = E * A;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A table at 44.1 kHz, 256 frames: an impulse of height 16384 at frame 20 in every response; delay 2 * index. */
function table(): ArrayBuffer {
  const len = 256;
  const buf = new ArrayBuffer(16 + 8 * D + 4 * D * len);
  const v = new DataView(buf);
  v.setUint32(0, E, true);
  v.setUint32(4, A, true);
  v.setUint32(8, len, true);
  v.setFloat32(12, 44100, true);
  for (let i = 0; i < D * 2; i++) v.setFloat32(16 + i * 4, i * 2, true);
  for (let d = 0; d < D; d++) for (let ear = 0; ear < 2; ear++) v.setInt16(16 + 8 * D + d * len * 4 + 20 * 4 + ear * 2, 16384, true);
  return buf;
}

describe("resampleHrir", () => {
  it("is the identity at the same rate", () => {
    const t = table();
    expect(resampleHrir(t, 44100)).toBe(t);
  });

  it("scales lengths, delays and impulse positions to 48 kHz", () => {
    const out = resampleHrir(table(), 48000);
    const head = readHrirHeader(out);
    expect(head).toEqual({ elevations: E, azimuths: A, irLength: Math.round((256 * 48000) / 44100), rate: 48000 });
    expect(out.byteLength).toBe(16 + 8 * D + 4 * D * head.irLength);
    const v = new DataView(out);
    expect(v.getFloat32(16 + 4 * 7, true)).toBeCloseTo(14 * (48000 / 44100), 3);
    // Direction 5, right ear: the impulse (frame 20) lands near frame 20 * 48000 / 44100 = 21.8 -> peak at 22.
    const base = 16 + 8 * D + 5 * head.irLength * 4 + 2;
    let peak = 0;
    let at = -1;
    for (let j = 0; j < head.irLength; j++) {
      const s = Math.abs(v.getInt16(base + j * 4, true));
      if (s > peak) [peak, at] = [s, j];
    }
    expect(at).toBe(22);
    expect(peak).toBeGreaterThan(12000);
    expect(peak).toBeLessThanOrEqual(16384 + 600);
  });

  it("rejects a truncated blob", () => {
    expect(() => resampleHrir(table().slice(0, 1000), 48000)).toThrow();
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

  it("warns once and stays not ready when the fetch fails", async () => {
    const h = harness(vi.fn(async () => Promise.reject(new Error("HTTP 404"))));
    h.loader.ensure();
    await settle();
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.loader.ready).toBe(false);
    expect(h.sent).toHaveLength(0);
  });
});
