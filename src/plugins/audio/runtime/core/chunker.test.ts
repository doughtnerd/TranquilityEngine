import { describe, expect, it } from "vitest";
import { CLIP_BYTES_PER_QUANTUM, createChunkPacer, planChunks } from "./chunker";

describe("planChunks (A1.3a-L1)", () => {
  it("splits into contiguous chunks of at most maxBytes, the last the remainder", () => {
    // 2 channels * 2 bytes = 4 bytes per frame; 10 bytes allows 2 frames per chunk.
    const plan = planChunks(5, 2, 2, 10);
    expect(plan).toEqual([
      { frameOffset: 0, frames: 2 },
      { frameOffset: 2, frames: 2 },
      { frameOffset: 4, frames: 1 },
    ]);
  });

  it("uses floor(maxBytes / (channels * bytesPerSample)) frames per chunk, at least 1", () => {
    // 3 channels * 4 bytes = 12 bytes per frame; 30 bytes floors to 2 frames.
    expect(planChunks(4, 3, 4, 30).map((c) => c.frames)).toEqual([2, 2]);
    // A budget smaller than one frame still gives one frame per chunk.
    expect(planChunks(3, 2, 4, 1).map((c) => c.frames)).toEqual([1, 1, 1]);
    // The default budget is the 256 KB quantum: mono 16-bit gives 131072 frames per chunk.
    const perChunk = CLIP_BYTES_PER_QUANTUM / 2;
    expect(planChunks(perChunk + 1, 1, 2)).toEqual([
      { frameOffset: 0, frames: perChunk },
      { frameOffset: perChunk, frames: 1 },
    ]);
  });

  it("gives no chunks for 0 frames", () => {
    expect(planChunks(0, 2, 4)).toEqual([]);
  });

  it("a clip that fits is one chunk", () => {
    expect(planChunks(100, 2, 4, 4096)).toEqual([{ frameOffset: 0, frames: 100 }]);
  });
});

describe("createChunkPacer (A1.3a-L1)", () => {
  it("take never returns more than the budget, except one unsplittable chunk", () => {
    const pacer = createChunkPacer();
    // Mono, 4 bytes per frame: chunks of 10 frames (40 bytes).
    pacer.enqueue(1, planChunks(30, 1, 4, 40), 1, 4);
    // Budget 100 fits two 40-byte chunks, not three.
    const first = pacer.take(100);
    expect(first.map((c) => c.bytes)).toEqual([40, 40]);
    expect(pacer.take(100).map((c) => c.bytes)).toEqual([40]);

    // A single chunk larger than the budget is still returned alone.
    const big = createChunkPacer();
    big.enqueue(2, planChunks(100, 1, 4, 400), 1, 4);
    const oversize = big.take(10);
    expect(oversize).toEqual([{ clipId: 2, frameOffset: 0, frames: 100, bytes: 400 }]);
  });

  it("round-robins across clips, one chunk per clip per turn", () => {
    const pacer = createChunkPacer();
    pacer.enqueue(1, planChunks(4, 1, 1, 1), 1, 1);
    pacer.enqueue(2, planChunks(2, 1, 1, 1), 1, 1);
    const taken = pacer.take(1000).map((c) => c.clipId);
    expect(taken).toEqual([1, 2, 1, 2, 1, 1]);
  });

  it("keeps one clip's chunks in order", () => {
    const pacer = createChunkPacer();
    pacer.enqueue(7, planChunks(6, 1, 1, 2), 1, 1);
    const offsets: number[] = [];
    let chunk = pacer.take(2);
    while (chunk.length > 0) {
      for (const c of chunk) offsets.push(c.frameOffset);
      chunk = pacer.take(2);
    }
    expect(offsets).toEqual([0, 2, 4]);
  });

  it("cancel drops a clip's pending chunks", () => {
    const pacer = createChunkPacer();
    pacer.enqueue(1, planChunks(4, 1, 1, 1), 1, 1);
    pacer.enqueue(2, planChunks(2, 1, 1, 1), 1, 1);
    pacer.cancel(1);
    pacer.cancel(99);
    expect(pacer.pending).toBe(2);
    expect(pacer.take(1000).map((c) => c.clipId)).toEqual([2, 2]);
  });

  it("pending counts across clips and take returns [] when empty", () => {
    const pacer = createChunkPacer();
    expect(pacer.pending).toBe(0);
    expect(pacer.take()).toEqual([]);
    pacer.enqueue(1, planChunks(4, 1, 1, 1), 1, 1);
    pacer.enqueue(2, planChunks(3, 1, 1, 1), 1, 1);
    expect(pacer.pending).toBe(7);
    pacer.take(2);
    expect(pacer.pending).toBe(5);
    pacer.take(1000);
    expect(pacer.pending).toBe(0);
    expect(pacer.take()).toEqual([]);
  });
});
