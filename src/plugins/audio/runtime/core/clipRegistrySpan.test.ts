// R4c (C14): span clips in the clip registry, against the fake decoder and manual frame and quantum clocks.
import { fakeDecoder, type PlanarClip } from "./fakeDecoder";
import { describe, expect, it, vi } from "vitest";
import type { DecodeClipOptions } from "../decoder/decoderClient";
import { ClipEvent, Kind, readClipBegin, readClipChunk, readClipUnload } from "../wire.generated";
import { createClipRegistry, MAX_SPAN_SECONDS, type ClipRegistryDeps } from "./clipRegistry";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const RATE = 48_000;

/** Mono ramp: sample k is k (as int16 via a scale of 1/32767), so a span's content says which frames it kept. */
function ramp(frames: number): PlanarClip {
  return { frames, channels: 1, sampleRate: RATE, channelData: [Float32Array.from({ length: frames }, (_, k) => k / 32767)] };
}

function harness(frames: number, over: Partial<ClipRegistryDeps> = {}) {
  const sent: ArrayBuffer[] = [];
  const frameQueue: (() => void)[] = [];
  const quantumQueue: (() => void)[] = [];
  const warn = vi.fn();
  const fetchBytes = vi.fn(async () => new ArrayBuffer(16));
  const decode = vi.fn(async () => ramp(frames));
  const registry = createClipRegistry({
    send: (m) => sent.push(m),
    fetchBytes,
    decodeWorker: fakeDecoder(decode),
    warn,
    nextFrame: (cb) => frameQueue.push(cb),
    nextQuantum: (cb) => quantumQueue.push(cb),
    ...over,
  });
  const kind = (m: ArrayBuffer) => new DataView(m).getUint16(6, true);
  const runFrame = () => frameQueue.splice(0).forEach((cb) => cb());
  const runQuanta = () => {
    for (let i = 0; i < 20 && quantumQueue.length > 0; i++) quantumQueue.splice(0).forEach((cb) => cb());
  };
  /** The clip's samples as the core received them, from its CLIP_CHUNKs. */
  const uploaded = (id: number): number[] => {
    const out: number[] = [];
    for (const m of sent) {
      if (kind(m) !== Kind.CLIP_CHUNK) continue;
      const c = readClipChunk(new DataView(m), 0);
      if (c.clipId === id) out.push(...new Int16Array(m, 32, c.frames));
    }
    return out;
  };
  return { registry, sent, warn, fetchBytes, decode, kind, runFrame, runQuanta, uploaded };
}

describe("clipRegistry span clips (R4c, C14)", () => {
  it("decodes [start, end) as its own clip id and uploads exactly those frames", async () => {
    const h = harness(100_000);
    const id = h.registry.acquireSpan!("a.wav", 1000, 5000);
    await settle();
    const whole = h.registry.acquire("a.wav");
    expect(id).not.toBe(whole);
    await settle();
    h.runQuanta();
    const begin = h.sent.filter((m) => h.kind(m) === Kind.CLIP_BEGIN).map((m) => readClipBegin(new DataView(m), 0));
    expect(begin.find((b) => b.clipId === id)).toMatchObject({ frames: 4000, channels: 1, sampleRate: RATE });
    expect(begin.find((b) => b.clipId === whole)).toMatchObject({ frames: 100_000 });
    const got = h.uploaded(id);
    expect(got).toHaveLength(4000);
    expect(got[0]).toBe(1000);
    expect(got[3999]).toBe(4999);
    expect(h.registry.info(id)).toMatchObject({ state: "copying", frames: 4000, bytes: 8000 });
    expect(h.registry.duration!("a.wav")).toBeCloseTo(100_000 / RATE); // duration(path) stays the whole file's
    expect(h.fetchBytes).toHaveBeenCalledTimes(1); // the span and the whole clip share the encoded bytes
    h.registry.applyClipEvent(id, ClipEvent.Resident);
    expect(h.registry.state(id)).toBe("ready");
  });

  it("shares a slot per path and range, and keeps two ranges apart", async () => {
    const h = harness(20_000);
    const a = h.registry.acquireSpan!("a.wav", 0, 100);
    expect(h.registry.acquireSpan!("a.wav", 0, 100)).toBe(a);
    expect(h.registry.acquireSpan!("a.wav", 0, 101)).not.toBe(a);
    expect(h.registry.info(a)!.refs).toBe(2);
    await settle();
  });

  it("clamps an end past the file's end, and fails a start past it", async () => {
    const h = harness(10_000);
    const tail = h.registry.acquireSpan!("a.wav", 9000, 20_000);
    const past = h.registry.acquireSpan!("a.wav", 12_000, 13_000);
    await settle();
    h.runQuanta();
    expect(h.registry.info(tail)).toMatchObject({ state: "copying", frames: 1000 });
    expect(h.uploaded(tail)).toHaveLength(1000);
    expect(h.registry.info(past)).toMatchObject({ state: "failed", failure: "decode" });
  });

  it("refuses a span over 30 s and a bad range, reported as failed without throwing", async () => {
    const h = harness(3_000_000);
    const long = h.registry.acquireSpan!("a.wav", 0, MAX_SPAN_SECONDS * RATE + 1);
    const exact = h.registry.acquireSpan!("a.wav", 0, MAX_SPAN_SECONDS * RATE);
    const bad = [h.registry.acquireSpan!("a.wav", 10, 10), h.registry.acquireSpan!("a.wav", -1, 10), h.registry.acquireSpan!("a.wav", 0.5, 10)];
    for (const id of bad) expect(h.registry.info(id)).toMatchObject({ state: "failed", failure: "refusedSpan" });
    await settle();
    expect(h.registry.info(long)).toMatchObject({ state: "failed", failure: "refusedSpan" });
    expect(h.registry.info(exact)).toMatchObject({ state: "copying", frames: MAX_SPAN_SECONDS * RATE });
    expect(h.sent.filter((m) => h.kind(m) === Kind.CLIP_BEGIN)).toHaveLength(1);
  });

  it("counts against the ceiling like any clip", async () => {
    const h = harness(100_000, { ceilingBytes: 10_000 });
    const fits = h.registry.acquireSpan!("a.wav", 0, 4000); // 8000 bytes
    await settle();
    const over = h.registry.acquireSpan!("a.wav", 4000, 8000);
    await settle();
    expect(h.registry.info(fits)!.state).toBe("copying");
    expect(h.registry.info(over)).toMatchObject({ state: "failed", failure: "refusedCeiling" });
    expect(h.warn).toHaveBeenCalledTimes(1);
    // Freeing the first makes room: a refused span is dropped, the next try loads.
    h.registry.release(fits);
    h.registry.release(over);
    h.runFrame();
    const again = h.registry.acquireSpan!("a.wav", 4000, 8000);
    await settle();
    expect(h.registry.info(again)!.state).toBe("copying");
  });

  it("frees with its voice: the last release unloads it one frame later", async () => {
    const h = harness(20_000);
    const id = h.registry.acquireSpan!("a.wav", 100, 600);
    h.registry.acquireSpan!("a.wav", 100, 600); // a second voice
    await settle();
    h.runQuanta();
    h.registry.applyClipEvent(id, ClipEvent.Resident);
    h.registry.release(id);
    h.runFrame();
    expect(h.registry.state(id)).toBe("ready"); // one voice still plays
    h.registry.release(id);
    expect(h.registry.state(id)).toBe("unloading");
    h.runFrame();
    expect(h.registry.state(id)).toBe("idle");
    const unloads = h.sent.filter((m) => h.kind(m) === Kind.CLIP_UNLOAD).map((m) => readClipUnload(new DataView(m), 0).clipId);
    expect(unloads).toEqual([id]);
    expect(h.registry.residentIds()).toEqual([]);
  });

  it("stops the worker decode once the span's end is reached", async () => {
    let aborted = false;
    const chunks = [Int16Array.from({ length: 1000 }, (_, k) => k), Int16Array.from({ length: 1000 }, (_, k) => 1000 + k), Int16Array.from({ length: 1000 }, (_, k) => 2000 + k)];
    const decodeWorker = {
      async decodeClip(_bytes: ArrayBuffer | Uint8Array, _hint?: number, options?: DecodeClipOptions) {
        const info = { rate: RATE, channels: 1, frames: 3000, framesEstimate: 3000, codec: 1, lengthKnown: true };
        options?.onInfo?.(info);
        for (let i = 0; i < chunks.length; i++) {
          if (options?.signal?.aborted) {
            aborted = true;
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
          }
          options?.onChunk?.(chunks[i]!, i);
          await Promise.resolve();
        }
        return { pcm: new Int16Array(0), rate: RATE, channels: 1, frames: 3000, info };
      },
    };
    const h = harness(0, { decodeWorker });
    const id = h.registry.acquireSpan!("a.wav", 500, 1500); // across the first two chunks
    await settle();
    h.runQuanta();
    expect(aborted).toBe(true);
    expect(h.registry.info(id)).toMatchObject({ state: "copying", frames: 1000 });
    const got = h.uploaded(id);
    expect(got[0]).toBe(500);
    expect(got[999]).toBe(1499);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("invalidate detaches every clip of the asset: the next acquire decodes the new file, old ids live until released", async () => {
    let version = 0;
    const fetchBytes = vi.fn(async () => new ArrayBuffer(16 + version));
    const h = harness(20_000, { fetchBytes });
    const old = h.registry.acquireSpan!("a.wav", 0, 100);
    await settle();
    const oldWhole = h.registry.acquire("a.wav");
    await settle();
    h.registry.applyClipEvent(old, ClipEvent.Resident);
    version = 1;
    h.registry.invalidate!("a.wav");
    expect(h.registry.state(old)).toBe("ready"); // still held
    const fresh = h.registry.acquireSpan!("a.wav", 0, 100);
    await settle();
    const freshWhole = h.registry.acquire("a.wav");
    expect(fresh).not.toBe(old);
    expect(freshWhole).not.toBe(oldWhole);
    await settle();
    expect(fetchBytes).toHaveBeenCalledTimes(2); // the kept bytes were dropped: one refetch, shared by the new clips
    h.registry.release(old);
    h.registry.release(oldWhole);
    h.runFrame();
    expect(h.registry.state(old)).toBe("idle");
    expect(h.registry.state(fresh)).not.toBe("idle");
    // An unreferenced clip is unloaded at once on invalidate.
    h.registry.release(fresh);
    h.registry.release(freshWhole);
    h.runFrame();
    expect(h.registry.state(fresh)).toBe("idle");
  });

  it("a rebuild's resend re-decodes span clips as spans", async () => {
    const h = harness(20_000);
    const id = h.registry.acquireSpan!("a.wav", 200, 400);
    await settle();
    h.runQuanta();
    h.registry.applyClipEvent(id, ClipEvent.Resident);
    const before = h.sent.length;
    h.registry.resend!([id]);
    await settle();
    h.runQuanta();
    const begin = h.sent.slice(before).filter((m) => h.kind(m) === Kind.CLIP_BEGIN).map((m) => readClipBegin(new DataView(m), 0));
    expect(begin).toEqual([expect.objectContaining({ clipId: id, frames: 200 })]);
    expect(h.registry.residentIds()).toEqual([]); // copying again until the new core says resident
  });
});
