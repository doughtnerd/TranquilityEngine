// A take uploaded by the build's `createTakeUploads` (runtime) arrives byte-identical through the tool's
// `createTakeReceiver` (editor). It lives on the editor side because the editor may import the runtime, never the
// other way round (plugins.test.ts).
import { describe, expect, it } from "vitest";
import { RecordWriter, readRecords } from "../../../../engine/debugLink/records";
import { decodeTakeChunk, TAKE_CHUNK_BYTES } from "../../runtime/debugLink/schema";
import { createTakeUploads } from "../../runtime/debugLink/upload";
import { createTakeReceiver } from "./takeReceiver";

const data = (n: number) => new Uint8Array(n).map((_, i) => (i * 13 + 5) & 255);

describe("a take upload end to end", () => {
  for (const size of [0, 1, TAKE_CHUNK_BYTES, TAKE_CHUNK_BYTES + 1, 4_000_000]) {
    it(`${size} bytes arrive byte-identical`, async () => {
      const src = data(size);
      const up = createTakeUploads({ bytes: async () => src, seconds: () => 2 });
      const reply = await up.begin({});
      const sub = up.subscribe(reply.upload);
      if ("refused" in sub) throw new Error(sub.refused);
      const rx = createTakeReceiver(reply);
      let result;
      for (let i = 0; i < reply.chunks; i++) {
        const w = new RecordWriter();
        sub.sample(w, i + 1);
        for (const record of readRecords(w.take()).records) {
          const chunk = decodeTakeChunk(record.payload);
          if ("refused" in chunk) throw new Error(chunk.refused);
          result = rx.push(chunk);
        }
      }
      expect(result?.status).toBe("done");
      expect(result?.status === "done" && Buffer.compare(result.bytes, src)).toBe(0);
    });
  }
});
