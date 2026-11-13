// ADR 0171/0172 (Rc1; api-and-models §5.1, §5.3, §5.4, §5.7; architecture §3.7): the reader opens stored and
// compressed files, round-trips every record, scans keyframes, checks the INDEX, appends live segments and refuses
// structural corruption. The full fuzz and bombs are format.fuzz.test.ts (L-Rc1a).
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_FLAG_COMPRESSED, CAPTURE_HEADER_BYTES, CAPTURE_RECORD_HEAD_BYTES, CaptureError, RecordType, assembleCapture,
  encodeRecords, readCaptureHeader, type CaptureErrorCode,
} from "./format";
import { decodeRecordAt, epochOf, openCapture, openLiveCapture, recordSeconds, type ReaderOptions } from "./reader";
import { SAMPLE_HEADER, SAMPLE_META, sampleCapture, sampleRecords, statusBytes } from "./testSupport";

async function codeOf(f: () => Promise<unknown>): Promise<CaptureErrorCode | "none"> {
  try {
    await f();
  } catch (e) {
    if (e instanceof CaptureError) return e.code;
    throw e;
  }
  return "none";
}

/** The stored file compressed as the saver would (deflate-raw after the header, `compressed` set). */
function compress(file: Uint8Array): Uint8Array {
  const z = deflateRawSync(file.subarray(CAPTURE_HEADER_BYTES));
  const out = new Uint8Array(CAPTURE_HEADER_BYTES + z.byteLength);
  out.set(file.subarray(0, CAPTURE_HEADER_BYTES));
  out.set(z, CAPTURE_HEADER_BYTES);
  const v = new DataView(out.buffer);
  v.setUint16(10, v.getUint16(10, true) | CAPTURE_FLAG_COMPRESSED, true);
  return out;
}

describe("openCapture", () => {
  it("round-trips every record of a stored file", async () => {
    const recs = sampleRecords();
    const c = await openCapture(sampleCapture());
    expect(c.records.count).toBe(recs.length + 1);
    for (let i = 0; i < recs.length; i++) {
      const d = decodeRecordAt(c, i);
      const r = recs[i]!;
      expect([d.type, d.epoch, d.seq, d.frame]).toEqual([r.type, r.epoch, r.seq, r.frame]);
      expect(d.stamp).toBe(r.stamp);
      if (r.payload instanceof Uint8Array) expect(Array.from(d.payload as Uint8Array)).toEqual(Array.from(r.payload));
      else expect(d.payload).toEqual(r.payload);
    }
    expect(decodeRecordAt(c, recs.length).kind).toBe("index");
    expect(c.keyframes).toEqual([1, 13]);
    expect(c.index?.entries.map((e) => e.seq)).toEqual([2, 14]);
    expect(c.warnings).toEqual([]);
    expect(c.names.clips.get(2)).toBe("land.ogg");
    expect(c.epochs.map((e) => [e.epoch, e.firstRecord, e.sampleRate])).toEqual([[0, 0, 48_000], [1, 12, 44_100]]);
    expect(epochOf(c, 14).epoch).toBe(1);
    expect(recordSeconds(c, 14)).toBeCloseTo(768 / 44_100 + 3.25, 12);
  });

  it("opens the same file compressed", async () => {
    const c = await openCapture(compress(sampleCapture()));
    expect(c.records.count).toBe(16);
    expect(decodeRecordAt(c, 5)).toMatchObject({ kind: "marker", payload: { text: "owner joined ✓" } });
  });

  it("opens without an INDEX by scanning, and warns when the INDEX disagrees", async () => {
    const plain = await openCapture(sampleCapture({ index: false }));
    expect(plain.index).toBeNull();
    expect(plain.keyframes).toEqual([1, 13]);
    const file = sampleCapture().slice();
    const v = new DataView(file.buffer);
    const h = readCaptureHeader(file);
    // The INDEX's first entry's seq (last record: head 20, count 4, entry: epoch 2, pad 2, frame 8, offset 4, seq 4).
    const at = CAPTURE_HEADER_BYTES + h.uncompressedBytes - h.indexBytes + CAPTURE_RECORD_HEAD_BYTES + 4 + 16;
    v.setUint32(at, 999, true);
    const c = await openCapture(file);
    expect(c.index).toBeNull();
    expect(c.warnings).toHaveLength(1);
  });

  it("reports allocations, none past the caps", async () => {
    const sizes: number[] = [];
    const opts: ReaderOptions = { onAllocate: (n) => sizes.push(n) };
    await openCapture(compress(sampleCapture()), opts);
    expect(sizes.length).toBeGreaterThan(0);
    // The record table is sized by records read up to recordCount (16), never by a larger header value.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it("stops a deflate bomb at the declared size + 1", async () => {
    const file = sampleCapture({ index: false });
    const h = readCaptureHeader(file);
    const bomb = deflateRawSync(new Uint8Array(4 * 1024 * 1024));
    const out = new Uint8Array(CAPTURE_HEADER_BYTES + bomb.byteLength);
    out.set(compress(file).subarray(0, CAPTURE_HEADER_BYTES));
    out.set(bomb, CAPTURE_HEADER_BYTES);
    let held = 0;
    expect(await codeOf(() => openCapture(out, { onAllocate: (n, what) => { if (what === "inflate") held += n; } }))).toBe("inflateOverrun");
    expect(held).toBeLessThanOrEqual(h.uncompressedBytes + 128 * 1024);
  });

  it("refuses structural corruption", async () => {
    const recs = sampleRecords();
    const bad = async (mutate: (r: ReturnType<typeof sampleRecords>) => void) => {
      const r = sampleRecords();
      mutate(r);
      return codeOf(() => openCapture(assembleCapture(SAMPLE_HEADER, SAMPLE_META, r)));
    };
    expect(await bad((r) => { r[3]!.seq = 2; })).toBe("badSeq");
    expect(await bad((r) => { r[12]!.epoch = 0; r[13]!.epoch = 0; r[14]!.epoch = 0; r[13]!.frame = 1536; r[14]!.frame = 1536; r[14]!.payload = statusBytes(1536); })).toBe("badEpoch");
    expect(await bad((r) => { r[4]!.frame = 50_000; })).toBe("disorder");
    expect(await bad((r) => { r.push({ type: RecordType.WRAP, epoch: 1, seq: 99, frame: 768, payload: new Uint8Array(0) }); })).toBe("badRecord");
    expect(await bad((r) => { r.push({ type: 0x80, epoch: 1, seq: 99, frame: 768, payload: new Uint8Array(0) }); })).toBe("unknownRequired");
    expect(await bad((r) => { r[2]!.frame = 769; })).toBe("badRecord");
    expect(recs.length).toBe(15);
  });

  it("refuses a recordCount that disagrees", async () => {
    const file = sampleCapture({ index: false }).slice();
    new DataView(file.buffer).setUint32(72, 14, true);
    expect(await codeOf(() => openCapture(file))).toBe("tooManyRecords");
    new DataView(file.buffer).setUint32(72, 16, true);
    expect(await codeOf(() => openCapture(file))).toBe("countMismatch");
  });
});

describe("openLiveCapture (R17, Rc6's appendSegment)", () => {
  it("appends sealed segments and continues seq and epoch checks across them", () => {
    const head = assembleCapture(SAMPLE_HEADER, SAMPLE_META, []);
    const d = openLiveCapture(head);
    const recs = sampleRecords();
    d.appendRecords(encodeRecords(recs.slice(0, 12)));
    d.appendRecords(encodeRecords(recs.slice(12)));
    expect(d.contents.records.count).toBe(15);
    expect(d.contents.segments).toHaveLength(2);
    expect(decodeRecordAt(d.contents, 13).kind).toBe("keyframe");
    expect(() => d.appendRecords(encodeRecords(recs.slice(14)))).toThrow(CaptureError);
  });
});
