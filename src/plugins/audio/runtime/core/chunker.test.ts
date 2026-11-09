import { describe, it } from "vitest";

describe("planChunks (A1.3a-L1)", () => {
  it.todo("splits into contiguous chunks of at most maxBytes, the last the remainder");
  it.todo("uses floor(maxBytes / (channels * bytesPerSample)) frames per chunk, at least 1");
  it.todo("gives no chunks for 0 frames");
  it.todo("a clip that fits is one chunk");
});

describe("createChunkPacer (A1.3a-L1)", () => {
  it.todo("take never returns more than the budget, except one unsplittable chunk");
  it.todo("round-robins across clips, one chunk per clip per turn");
  it.todo("keeps one clip's chunks in order");
  it.todo("cancel drops a clip's pending chunks");
  it.todo("pending counts across clips and take returns [] when empty");
});
