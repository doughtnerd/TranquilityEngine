import { describe, expect, it } from "vitest";
import { RecordWriter, readRecords } from "../../../../engine/debugLink/records";
import { AUDIO_SAMPLE_BYTES, decodeTakeChunk, TAKE_CHUNK_BYTES } from "./schema";
import { createTakeUploads } from "./upload";

const source = (bytes: Uint8Array) => ({ bytes: async () => bytes, seconds: () => 2 });
const data = (n: number) => new Uint8Array(n).map((_, i) => (i * 13 + 5) & 255);

/** Samples `sub` once into a writer, returning the decoded chunks. */
function pull(sub: { sample(out: RecordWriter, frame: number): void }) {
  const w = new RecordWriter();
  sub.sample(w, 1);
  const bytes = w.take();
  expect(bytes.byteLength).toBeLessThanOrEqual(AUDIO_SAMPLE_BYTES);
  return readRecords(bytes).records.map((r) => decodeTakeChunk(r.payload));
}

describe("createTakeUploads", () => {
  for (const size of [0, 1, TAKE_CHUNK_BYTES, TAKE_CHUNK_BYTES + 1, 65_536, 4_000_000]) {
    it(`uploads ${size} bytes byte-identically`, async () => {
      const src = data(size);
      const up = createTakeUploads(source(src));
      const reply = await up.begin({});
      expect(reply.bytes).toBe(size);
      expect(reply.chunks).toBe(Math.max(1, Math.ceil(size / TAKE_CHUNK_BYTES)));
      const sub = up.subscribe(reply.upload);
      if ("refused" in sub) throw new Error(sub.refused);
      // The tool's reassembly is tested on the editor side (editor/debugLink/takeRoundTrip.test.ts); runtime code never
      // imports the editor (plugins.test.ts), so here the chunks are checked and joined directly.
      const parts: Uint8Array[] = [];
      for (let i = 0; i < reply.chunks; i++) {
        const got = pull(sub);
        expect(got.length).toBe(1);
        const chunk = got[0];
        if ("refused" in chunk) throw new Error(chunk.refused);
        expect(chunk).toMatchObject({ upload: reply.upload, index: i, total: reply.chunks });
        parts.push(chunk.bytes);
      }
      expect(Buffer.compare(Buffer.concat(parts), src)).toBe(0);
      expect(pull(sub)).toEqual([]);
    });
  }

  it("refuses a second upload while one is in flight, and allows one after it is cancelled", async () => {
    const up = createTakeUploads(source(data(TAKE_CHUNK_BYTES * 3)));
    const reply = await up.begin({});
    const sub = up.subscribe(reply.upload);
    if ("refused" in sub) throw new Error(sub.refused);
    pull(sub);
    await expect(up.begin({})).rejects.toThrow(/in progress/);
    expect(up.subscribe(reply.upload)).toHaveProperty("refused");
    sub.close();
    // Abandoned: the tool may subscribe again from chunk 0.
    const again = up.subscribe(reply.upload);
    if ("refused" in again) throw new Error(again.refused);
    const first = pull(again)[0];
    expect("refused" in first ? -1 : first.index).toBe(0);
    again.close();
    const next = await up.begin({});
    expect(next.upload).not.toBe(reply.upload);
    expect(up.subscribe(reply.upload)).toHaveProperty("refused");
  });

  it("refuses a concurrent begin while the bytes are being made", async () => {
    const up = createTakeUploads(source(data(10)));
    const first = up.begin({});
    await expect(up.begin({})).rejects.toThrow(/in progress/);
    await first;
  });

  it("aborts when the link closes", async () => {
    const up = createTakeUploads(source(data(TAKE_CHUNK_BYTES * 2)));
    const reply = await up.begin({});
    const sub = up.subscribe(reply.upload);
    if ("refused" in sub) throw new Error(sub.refused);
    pull(sub);
    up.dispose();
    expect(pull(sub)).toEqual([]);
    expect(up.subscribe(reply.upload)).toHaveProperty("refused");
    await expect(up.begin({})).rejects.toThrow();
  });

  it("passes on a source error", async () => {
    const up = createTakeUploads({
      bytes: async () => {
        throw new Error("nothing recorded: call Audio.take.start() first");
      },
      seconds: () => 0,
    });
    await expect(up.begin({})).rejects.toThrow(/nothing recorded/);
    await expect(up.begin({})).rejects.toThrow(/nothing recorded/);
  });
});
