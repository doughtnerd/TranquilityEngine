// A1.3a: the clip registry against fakes for send / fetchBytes / decode and manual frame and quantum clocks.
import { describe, expect, it, vi } from "vitest";
import { ClipEvent, ClipFormat, Kind, readClipBegin, readClipChunk, readClipUnload } from "../wire.generated";
import { CLIP_BYTES_PER_QUANTUM } from "./chunker";
import { CLIP_INDEX_LIMIT, clipGeneration, clipIndex, createClipRegistry, makeClipId, type ClipRegistryDeps, type DecodedClip } from "./clipRegistry";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(over: Partial<ClipRegistryDeps> = {}, clip: Partial<DecodedClip> = {}) {
  const sent: ArrayBuffer[] = [];
  const frames = clip.frames ?? 200_000;
  const decoded: DecodedClip = {
    frames,
    channels: clip.channels ?? 2,
    sampleRate: 48_000,
    channelData: clip.channelData ?? [new Float32Array(frames).fill(1), new Float32Array(frames).fill(-1)],
  };
  const frameQueue: (() => void)[] = [];
  const quantumQueue: (() => void)[] = [];
  const warn = vi.fn();
  const fetchBytes = vi.fn(async () => new ArrayBuffer(16));
  const decode = vi.fn(async () => decoded);
  const registry = createClipRegistry({
    send: (m) => sent.push(m),
    fetchBytes,
    decode,
    warn,
    nextFrame: (cb) => frameQueue.push(cb),
    nextQuantum: (cb) => quantumQueue.push(cb),
    ...over,
  });
  const kind = (m: ArrayBuffer) => new DataView(m).getUint16(6, true);
  const runFrame = () => frameQueue.splice(0).forEach((cb) => cb());
  const runQuantum = () => quantumQueue.splice(0).forEach((cb) => cb());
  return { registry, sent, warn, fetchBytes, decode, kind, runFrame, runQuantum, quantumQueue };
}

describe("clipRegistry (A1.3a)", () => {
  it("acquire runs fetching, decoding, copying and sends CLIP_BEGIN then paced CLIP_CHUNKs", async () => {
    const h = harness();
    const id = h.registry.acquire("a.wav");
    expect(h.registry.state(id)).toBe("fetching");
    await settle();
    expect(h.registry.state(id)).toBe("copying");
    expect(h.sent.map(h.kind)).toEqual([Kind.CLIP_BEGIN]);
    const begin = readClipBegin(new DataView(h.sent[0]!), 0);
    expect(begin).toEqual({ clipId: id, frames: 200_000, channels: 2, sampleRate: 48_000, format: ClipFormat.I16 });
    // 200,000 stereo i16 frames = 800,000 bytes: 4 chunks of at most 256 KB, one per quantum tick.
    const sizes: number[] = [];
    let offset = 0;
    for (let tick = 0; tick < 10 && h.quantumQueue.length > 0; tick++) {
      const before = h.sent.length;
      h.runQuantum();
      const chunks = h.sent.slice(before);
      let bytes = 0;
      for (const m of chunks) {
        expect(h.kind(m)).toBe(Kind.CLIP_CHUNK);
        const c = readClipChunk(new DataView(m), 0);
        expect(c.clipId).toBe(id);
        expect(c.frameOffset).toBe(offset);
        offset += c.frames;
        bytes += c.frames * 4;
        expect(m.byteLength).toBe(32 + c.frames * 4);
      }
      expect(bytes).toBeLessThanOrEqual(CLIP_BYTES_PER_QUANTUM);
      sizes.push(bytes);
    }
    expect(offset).toBe(200_000);
    expect(sizes.length).toBe(4);
    const first = new Int16Array(h.sent[1]!, 32, 4);
    expect([...first]).toEqual([32767, -32768, 32767, -32768]);
  });

  it("sends f32 chunks when clipFormat is f32", async () => {
    const h = harness({ clipFormat: ClipFormat.F32 }, { frames: 4, channels: 1, channelData: [Float32Array.of(0.5, -0.5, 0.25, 0)] });
    h.registry.acquire("a.wav");
    await settle();
    h.runQuantum();
    expect(h.sent.map(h.kind)).toEqual([Kind.CLIP_BEGIN, Kind.CLIP_CHUNK]);
    expect([...new Float32Array(h.sent[1]!, 32, 4)]).toEqual([0.5, -0.5, 0.25, 0]);
  });

  it("pads an odd int16 sample count to a word and bodyBytes covers it", async () => {
    const h = harness({}, { frames: 3, channels: 1, channelData: [Float32Array.of(1, 1, 1)] });
    h.registry.acquire("a.wav");
    await settle();
    h.runQuantum();
    const chunk = h.sent[1]!;
    expect(chunk.byteLength).toBe(32 + 8);
    expect(new DataView(chunk).getUint32(12, true)).toBe(chunk.byteLength - 16);
    expect(readClipChunk(new DataView(chunk), 0).frames).toBe(3);
  });

  it("the resident clip event makes the clip ready and calls onResident once", async () => {
    const h = harness();
    const id = h.registry.acquire("a.wav");
    const seen: string[] = [];
    h.registry.onResident(id, (info) => seen.push(info.state));
    await settle();
    expect(seen).toEqual([]);
    h.registry.applyClipEvent(id, ClipEvent.Resident);
    h.registry.applyClipEvent(id, ClipEvent.Resident);
    expect(h.registry.state(id)).toBe("ready");
    expect(seen).toEqual(["ready"]);
    expect(h.registry.residentIds()).toEqual([id]);
    const late = vi.fn();
    h.registry.onResident(id, late);
    expect(late).toHaveBeenCalledTimes(1);
    const unsub = vi.fn();
    const off = h.registry.onResident(h.registry.acquire("b.wav"), unsub);
    off();
    expect(unsub).not.toHaveBeenCalled();
  });

  it("the same path gives the same id and refcounts unload one frame after refs and holders reach 0", async () => {
    const h = harness({}, { frames: 4, channels: 1, channelData: [new Float32Array(4)] });
    const a = h.registry.acquire("a.wav");
    const b = h.registry.acquire("a.wav", 3);
    expect(b).toBe(a);
    expect(h.registry.info(a)!.refs).toBe(3); // two acquires plus one holder
    await settle();
    h.runQuantum();
    h.registry.applyClipEvent(a, ClipEvent.Resident);
    h.registry.release(a);
    h.registry.release(a);
    h.runFrame();
    expect(h.registry.state(a)).toBe("ready"); // World 3 still holds it
    h.registry.releaseWorld(3);
    expect(h.registry.state(a)).toBe("unloading");
    expect(h.sent.map(h.kind)).not.toContain(Kind.CLIP_UNLOAD);
    h.runFrame();
    expect(h.sent.map(h.kind).at(-1)).toBe(Kind.CLIP_UNLOAD);
    expect(readClipUnload(new DataView(h.sent.at(-1)!), 0).clipId).toBe(a);
    expect(h.registry.state(a)).toBe("idle");
    expect(h.registry.info(a)).toBeNull();
    expect(h.registry.residentIds()).toEqual([]);
  });

  it("acquiring before the deferred unload runs cancels it", async () => {
    const h = harness({}, { frames: 4, channels: 1, channelData: [new Float32Array(4)] });
    const a = h.registry.acquire("a.wav");
    await settle();
    h.registry.release(a);
    expect(h.registry.state(a)).toBe("unloading");
    expect(h.registry.acquire("a.wav")).toBe(a);
    h.runFrame();
    expect(h.registry.state(a)).toBe("copying");
    expect(h.fetchBytes).toHaveBeenCalledTimes(1);
  });

  it("releasing an unknown id or past zero is ignored", () => {
    const h = harness();
    h.registry.release(12345);
    const a = h.registry.acquire("a.wav");
    h.registry.release(a);
    h.registry.release(a);
    expect(h.registry.info(a)!.refs).toBe(0);
  });

  it("a refusal event fails the clip with one warning", async () => {
    const h = harness();
    const id = h.registry.acquire("a.wav");
    const seen = vi.fn();
    h.registry.onResident(id, seen);
    await settle();
    h.registry.applyClipEvent(id, ClipEvent.RefusedCeiling);
    h.registry.applyClipEvent(id, ClipEvent.RefusedCeiling);
    expect(h.registry.info(id)).toMatchObject({ state: "failed", failure: "refusedCeiling" });
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledTimes(1);
    // Its pending chunks are dropped.
    h.runQuantum();
    expect(h.sent.map(h.kind)).toEqual([Kind.CLIP_BEGIN]);
    const grow = h.registry.acquire("b.wav");
    await settle();
    h.registry.applyClipEvent(grow, ClipEvent.RefusedGrow);
    expect(h.registry.info(grow)!.failure).toBe("refusedGrow");
  });

  it("fails without sending when the clip would pass the ceiling", async () => {
    const h = harness({ ceilingBytes: 1000 });
    const id = h.registry.acquire("big.wav");
    await settle();
    expect(h.registry.info(id)).toMatchObject({ state: "failed", failure: "refusedCeiling" });
    expect(h.sent).toEqual([]);
  });

  it("a fetch or decode failure fails the clip with one warning each", async () => {
    const h = harness({ fetchBytes: async () => Promise.reject(new Error("HTTP 404")) });
    const id = h.registry.acquire("missing.wav");
    await settle();
    expect(h.registry.info(id)).toMatchObject({ state: "failed", failure: "fetch" });
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0]![0]).toContain("missing.wav");

    const d = harness({ decode: async () => Promise.reject(new Error("bad data")) });
    const id2 = d.registry.acquire("bad.wav");
    await settle();
    expect(d.registry.info(id2)).toMatchObject({ state: "failed", failure: "decode" });
    expect(d.warn).toHaveBeenCalledTimes(1);
    expect(d.sent).toEqual([]);
  });

  it("a failed clip unloads without a CLIP_UNLOAD and a later acquire retries", async () => {
    const h = harness({ fetchBytes: vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(new ArrayBuffer(8)) }, { frames: 4, channels: 1, channelData: [new Float32Array(4)] });
    const a = h.registry.acquire("a.wav");
    await settle();
    expect(h.registry.state(a)).toBe("failed");
    h.registry.release(a);
    h.runFrame();
    expect(h.sent).toEqual([]);
    const b = h.registry.acquire("a.wav");
    expect(b).not.toBe(a);
    await settle();
    expect(h.registry.state(b)).toBe("copying");
  });

  it("a clip freed mid-load stops: nothing is sent", async () => {
    const h = harness();
    const id = h.registry.acquire("a.wav");
    h.registry.release(id);
    h.runFrame();
    await settle();
    expect(h.sent).toEqual([]);
    expect(h.registry.state(id)).toBe("idle");
  });

  it("ids carry a generation that changes when an index is reused", async () => {
    const h = harness({}, { frames: 4, channels: 1, channelData: [new Float32Array(4)] });
    const a = h.registry.acquire("a.wav");
    expect(clipGeneration(a)).toBe(0);
    h.registry.release(a);
    h.runFrame();
    const b = h.registry.acquire("b.wav");
    expect(clipIndex(b)).toBe(clipIndex(a));
    expect(clipGeneration(b)).toBe(1);
    h.registry.release(b);
    h.runFrame();
    const c = h.registry.acquire("c.wav");
    expect(clipIndex(c)).toBe(clipIndex(a));
    expect(clipGeneration(c)).toBe(2);
    expect(h.registry.state(a)).toBe("idle"); // the stale id is unknown
    await settle();
  });

  it("never hands out an id in the reserved HRIR range 0xFFFF0000..0xFFFF00FF", () => {
    expect(CLIP_INDEX_LIMIT).toBe(0xff0000);
    for (let generation = 0; generation < 256; generation++) {
      for (const index of [0, 1, CLIP_INDEX_LIMIT - 1]) {
        const id = makeClipId(index, generation);
        expect(id < 0xffff0000 || id > 0xffff00ff).toBe(true);
      }
    }
    // The first index that would collide (generation 0xFF) is the limit itself.
    expect(makeClipId(CLIP_INDEX_LIMIT, 0xff)).toBe(0xffff0000);
  });
});
