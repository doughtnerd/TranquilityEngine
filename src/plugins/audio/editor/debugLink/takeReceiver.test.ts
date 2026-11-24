import { describe, expect, it } from "vitest";
import { createTakeReceiver } from "./takeReceiver";
import type { TakeChunk, TakeUploadReply } from "../../runtime/debugLink/schema";
import { TAKE_CHUNK_BYTES } from "../../runtime/debugLink/schema";

function setup(size: number) {
  const chunks = Math.max(1, Math.ceil(size / TAKE_CHUNK_BYTES));
  const reply: TakeUploadReply = { upload: 3, bytes: size, chunks, chunkBytes: TAKE_CHUNK_BYTES, seconds: 1 };
  const all: TakeChunk[] = [];
  const src = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 255);
  for (let i = 0; i < chunks; i++) all.push({ upload: 3, index: i, total: chunks, bytes: src.subarray(i * TAKE_CHUNK_BYTES, (i + 1) * TAKE_CHUNK_BYTES) });
  return { reply, all, src };
}

describe("takeReceiver", () => {
  for (const size of [0, 1, TAKE_CHUNK_BYTES, TAKE_CHUNK_BYTES + 1, 5_000_000]) {
    it(`reassembles ${size} bytes`, () => {
      const { reply, all, src } = setup(size);
      const r = createTakeReceiver(reply);
      let res = r.push(all[0]);
      for (let i = 1; i < all.length; i++) {
        expect(res.status).toBe("more");
        res = r.push(all[i]);
      }
      expect(res.status).toBe("done");
      expect(res.status === "done" && Buffer.compare(res.bytes, src)).toBe(0);
    });
  }

  it("refuses a gap", () => {
    const { reply, all } = setup(TAKE_CHUNK_BYTES * 3);
    const r = createTakeReceiver(reply);
    r.push(all[0]);
    expect(r.push(all[2])).toMatchObject({ status: "error", error: expect.stringContaining("missing") });
    expect(r.push(all[1]).status).toBe("error");
  });
  it("refuses a duplicate", () => {
    const { reply, all } = setup(TAKE_CHUNK_BYTES * 3);
    const r = createTakeReceiver(reply);
    r.push(all[0]);
    expect(r.push(all[0])).toMatchObject({ status: "error", error: expect.stringContaining("twice") });
  });
  it("refuses a wrong total, upload, or size", () => {
    const { reply, all } = setup(TAKE_CHUNK_BYTES * 2);
    expect(createTakeReceiver(reply).push({ ...all[0], total: 5 }).status).toBe("error");
    expect(createTakeReceiver(reply).push({ ...all[0], upload: 9 }).status).toBe("error");
    expect(createTakeReceiver(reply).push({ ...all[0], bytes: all[0].bytes.subarray(1) }).status).toBe("error");
    const r = createTakeReceiver(reply);
    r.push(all[0]);
    expect(r.push({ ...all[1], bytes: new Uint8Array(TAKE_CHUNK_BYTES + 1) }).status).toBe("error");
    const short = createTakeReceiver(reply);
    short.push(all[0]);
    expect(short.push({ ...all[1], bytes: all[1].bytes.subarray(1) })).toMatchObject({ status: "error" });
  });
});
