// ADR 0171/0172 (Rc1, leaf L-Rc1a; api-and-models §10 capture row, §5.1, §5.3, §5.7): decode fuzz and bombs. Each
// case ends in a `CaptureError` with the code named, and no allocation the reader reports (`ReaderOptions.onAllocate`)
// passes the caps. Build inputs with `testSupport.ts` (`sampleCapture`, `sampleRecords`) and `format.ts`'s writers.
// L-Rc1a: fill each skipped case and un-skip it; add cases, never remove one.
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_FLAG_COMPRESSED, CAPTURE_HEADER_BYTES, CAPTURE_MARKER_MAX_BYTES, CAPTURE_MAX_NAMES, CAPTURE_MAX_UNCOMPRESSED_BYTES,
  CAPTURE_META_MAX_BYTES, CAPTURE_NAME_MAX_BYTES, CAPTURE_RECORD_HEAD_BYTES, CAPTURE_RECORD_MAX_BYTES, CaptureError,
  DEFERRED_STAMP_BYTES, RECORD_FLAG_DEFERRED, RecordType, assembleCapture, encodeCaptureMeta, readCaptureHeader,
  type CaptureErrorCode, type CaptureRecordInit,
} from "./format";
import { RECORD_TABLE_INITIAL, RecordTable, decodeRecordAt, openCapture, type ReaderOptions } from "./reader";
import { SAMPLE_HEADER, SAMPLE_META, sampleCapture, sampleRecords } from "./testSupport";
import { STATUS_BUFFER_BYTES } from "../wire.generated";

type Outcome = CaptureErrorCode | "opened";
type What = "records" | "inflate" | "payload";

const MiB = 1024 * 1024;
const SELF_CHECKED_TYPES: ReadonlySet<number> = new Set([
  RecordType.EPOCH, RecordType.GAP, RecordType.STATUS, RecordType.EVENT, RecordType.MARKER, RecordType.NAMES, RecordType.MIXOP,
  RecordType.INDEX,
]);

/** Opens `file`: "opened", or the code of the CaptureError it threw. Any other error is the test's failure. */
async function outcome(file: Uint8Array, opts: ReaderOptions = {}): Promise<Outcome> {
  try {
    await openCapture(file, opts);
    return "opened";
  } catch (e) {
    if (e instanceof CaptureError) return e.code;
    throw e;
  }
}

/** Collects every allocation the reader reports, by kind. */
function recorder() {
  const sizes: { bytes: number; what: What }[] = [];
  const of = (what: What) => sizes.filter((s) => s.what === what).map((s) => s.bytes);
  const opts: ReaderOptions = { onAllocate: (bytes: number, what: What) => { sizes.push({ bytes, what }); } };
  return {
    opts,
    sizes,
    max: (what: What) => Math.max(0, ...of(what)),
    total: (what: What) => of(what).reduce((a, b) => a + b, 0),
  };
}

/**
 * The most a record table may allocate while reading a payload of `bytes`: its first capacity, or twice the records the
 * payload can hold (rows grow by doubling and never past the records read, reader.ts `RecordTable.reserve`).
 */
function tableCap(bytes: number): number {
  return Math.max(RECORD_TABLE_INITIAL, 2 * Math.ceil(bytes / CAPTURE_RECORD_HEAD_BYTES)) * RecordTable.ROW_BYTES;
}

/** A copy of `file` with `edit` applied to its bytes. */
function edited(file: Uint8Array, edit: (v: DataView) => void): Uint8Array {
  const out = file.slice();
  edit(new DataView(out.buffer, out.byteOffset, out.byteLength));
  return out;
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

/** The head offset of every record in a stored file, walked by each head's own `len` from the records' start. */
function recordHeads(file: Uint8Array): number[] {
  const h = readCaptureHeader(file);
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const heads: number[] = [];
  for (let at = CAPTURE_HEADER_BYTES + h.metaBytes; at < file.byteLength; at += CAPTURE_RECORD_HEAD_BYTES + v.getUint32(at + 4, true)) {
    heads.push(at);
  }
  return heads;
}

/** Where the record whose head is at `head` has its payload (after the head and any deferred stamp). */
function payloadOf(file: Uint8Array, head: number): number {
  return head + CAPTURE_RECORD_HEAD_BYTES + (file[head + 1]! & RECORD_FLAG_DEFERRED ? DEFERRED_STAMP_BYTES : 0);
}

/** The head offset of the `nth` record of `type`. */
function nthOf(file: Uint8Array, type: number, nth = 0): number {
  return recordHeads(file).filter((at) => file[at] === type)[nth]!;
}

/** A deflate bomb's file: the header of `plain` with `compressed` set and `body` after it. */
function bombFile(plain: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(CAPTURE_HEADER_BYTES + body.byteLength);
  out.set(plain.subarray(0, CAPTURE_HEADER_BYTES));
  out.set(body, CAPTURE_HEADER_BYTES);
  const v = new DataView(out.buffer);
  v.setUint16(10, v.getUint16(10, true) | CAPTURE_FLAG_COMPRESSED, true);
  return out;
}

/** A seeded PRNG (mulberry32): the same mutations on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One random mutation: flipped bytes, a set byte, a truncation, appended bytes, or an interesting u32. */
function mutateOnce(base: Uint8Array, rnd: () => number): Uint8Array {
  const pick = (n: number) => Math.floor(rnd() * n);
  const out = base.slice();
  switch (pick(5)) {
    case 0: {
      for (let k = 1 + pick(4); k > 0; k--) {
        const j = pick(out.length);
        out[j] = out[j]! ^ (1 + pick(255));
      }
      return out;
    }
    case 1: {
      out[pick(out.length)] = pick(256);
      return out;
    }
    case 2: return out.slice(0, pick(out.length));
    case 3: {
      const extra = new Uint8Array(1 + pick(8));
      for (let i = 0; i < extra.length; i++) extra[i] = pick(256);
      const grown = new Uint8Array(out.length + extra.length);
      grown.set(out);
      grown.set(extra, out.length);
      return grown;
    }
    default: {
      const values = [0, 1, 0x7fffffff, 0xffffffff, 0x100000, CAPTURE_MAX_UNCOMPRESSED_BYTES + 1];
      const j = pick(Math.max(1, out.length - 3));
      new DataView(out.buffer).setUint32(j, values[pick(values.length)]!, true);
      return out;
    }
  }
}

// --- header refusals (§5.1) -------------------------------------------------------------------------------------------

/** One header field set to a value §5.1 refuses, with the code it refuses with. */
const HEADER_REFUSALS: readonly [name: string, edit: (v: DataView) => void, code: CaptureErrorCode][] = [
  ["magic", (v) => v.setUint8(0, 0), "badMagic"],
  ["format above this build's", (v) => v.setUint16(8, 2, true), "newerFormat"],
  ["format below this build's", (v) => v.setUint16(8, 0, true), "olderFormat"],
  ["flags, an unknown bit", (v) => v.setUint16(10, v.getUint16(10, true) | 0x10, true), "badHeader"],
  ["schemaHash", (v) => v.setUint8(12, v.getUint8(12) ^ 0xff), "wireMismatch"],
  ["abiVersion", (v) => v.setUint32(28, 0x300, true), "badHeader"],
  ["envelope major", (v) => v.setUint16(32, 99, true), "badHeader"],
  ["envelope minor", (v) => v.setUint16(34, 99, true), "badHeader"],
  ["statusBytesMax", (v) => v.setUint32(36, 1, true), "badHeader"],
  ["sampleRate below 8 kHz", (v) => v.setUint32(40, 0, true), "badHeader"],
  ["sampleRate past 384 kHz", (v) => v.setUint32(40, 384_001, true), "badHeader"],
  ["quantumFrames", (v) => v.setUint16(44, 0, true), "badHeader"],
  ["statusEveryQuanta", (v) => v.setUint8(46, 0xfe), "badHeader"],
  ["preset past 2", (v) => v.setUint8(47, 3), "badHeader"],
  ["startDateMs NaN", (v) => v.setFloat64(48, NaN, true), "badHeader"],
  ["startDateMs negative", (v) => v.setFloat64(48, -1, true), "badHeader"],
  ["keyframeIntervalMs", (v) => v.setUint32(56, 999, true), "badHeader"],
  ["metaBytes past 1 MiB", (v) => v.setUint32(60, CAPTURE_META_MAX_BYTES + 1, true), "metaTooLarge"],
  ["recordBytes off by one", (v) => v.setUint32(64, v.getUint32(64, true) + 1, true), "badHeader"],
  ["uncompressedBytes past 64 MiB", (v) => v.setUint32(68, CAPTURE_MAX_UNCOMPRESSED_BYTES + 1, true), "tooLarge"],
  ["uncompressedBytes 4 GB", (v) => v.setUint32(68, 0xffff_ffff, true), "tooLarge"],
  ["recordCount past uncompressedBytes / 20", (v) => v.setUint32(72, 0xffff_ffff, true), "tooManyRecords"],
  ["indexBytes zero with hasIndex", (v) => v.setUint32(76, 0, true), "badHeader"],
  ["indexBytes 4 GB", (v) => v.setUint32(76, 0xffff_ffff, true), "badHeader"],
  ["reserved not 0", (v) => v.setUint32(84, 1, true), "badHeader"],
  ["firstFrame NaN", (v) => v.setFloat64(88, NaN, true), "badHeader"],
  ["firstFrame negative", (v) => v.setFloat64(88, -1, true), "badHeader"],
];

// --- record payload refusals (§5.3, §5.4, §5.6) -----------------------------------------------------------------------

/** One payload field set out of its domain: the record type, which one of that type (0-based), the write, the code. */
const PAYLOAD_REFUSALS: readonly [name: string, type: number, nth: number, write: (v: DataView, p: number) => void, code: CaptureErrorCode][] = [
  ["EPOCH reason past 6", RecordType.EPOCH, 0, (v, p) => v.setUint8(p, 7), "badValue"],
  ["EPOCH sample rate 0", RecordType.EPOCH, 0, (v, p) => v.setUint32(p + 4, 0, true), "badValue"],
  ["EPOCH sample rate past 384 kHz", RecordType.EPOCH, 0, (v, p) => v.setUint32(p + 4, 384_001, true), "badValue"],
  ["EPOCH timeOffset NaN", RecordType.EPOCH, 0, (v, p) => v.setFloat64(p + 16, NaN, true), "badValue"],
  ["GAP reason 0", RecordType.GAP, 0, (v, p) => v.setUint8(p, 0), "badValue"],
  ["GAP reason 6", RecordType.GAP, 0, (v, p) => v.setUint8(p, 6), "badValue"],
  ["GAP perfTo before perfFrom", RecordType.GAP, 0, (v, p) => v.setFloat64(p + 12, 1000, true), "badValue"],
  ["GAP lastSeq before firstSeq", RecordType.GAP, 0, (v, p) => v.setUint32(p + 20, 5, true), "badValue"],
  ["EVENT kind 0", RecordType.EVENT, 0, (v, p) => v.setUint8(p + 8, 0), "badValue"],
  ["EVENT kind past 19", RecordType.EVENT, 0, (v, p) => v.setUint8(p + 8, 20), "badValue"],
  ["EVENT reason 0 for voiceStop", RecordType.EVENT, 1, (v, p) => v.setUint8(p + 9, 0), "badValue"],
  ["EVENT reason past its kind's maximum", RecordType.EVENT, 1, (v, p) => v.setUint8(p + 9, 6), "badValue"],
  ["EVENT argc one short of its len", RecordType.EVENT, 0, (v, p) => v.setUint16(p + 10, 1, true), "badLength"],
  ["EVENT argc 65,535", RecordType.EVENT, 0, (v, p) => v.setUint16(p + 10, 0xffff, true), "badLength"],
  ["MARKER n past 120", RecordType.MARKER, 0, (v, p) => v.setUint16(p + 8, CAPTURE_MARKER_MAX_BYTES + 1, true), "textTooLong"],
  ["MARKER n one short of its len", RecordType.MARKER, 0, (v, p) => v.setUint16(p + 8, 5, true), "badLength"],
  ["NAMES table 6", RecordType.NAMES, 0, (v, p) => v.setUint8(p, 6), "badValue"],
  ["NAMES n past 256", RecordType.NAMES, 0, (v, p) => v.setUint16(p + 8, CAPTURE_NAME_MAX_BYTES + 1, true), "textTooLong"],
  ["NAMES n one short of its len", RecordType.NAMES, 0, (v, p) => v.setUint16(p + 8, 1, true), "badLength"],
  ["MIXOP op 17", RecordType.MIXOP, 0, (v, p) => v.setUint8(p, 17), "badValue"],
  ["MIXOP class 5", RecordType.MIXOP, 0, (v, p) => v.setUint8(p + 1, 5), "badValue"],
  ["MIXOP argc one short of its len", RecordType.MIXOP, 0, (v, p) => v.setUint16(p + 2, 4, true), "badLength"],
  ["MIXOP origin 5", RecordType.MIXOP, 0, (v, p) => v.setUint8(p + 32, 5), "badValue"],
  ["INDEX count one past its len", RecordType.INDEX, 0, (v, p) => v.setUint32(p, 3, true), "badLength"],
  ["INDEX count zero", RecordType.INDEX, 0, (v, p) => v.setUint32(p, 0, true), "badLength"],
  ["INDEX count 4 GB", RecordType.INDEX, 0, (v, p) => v.setUint32(p, 0xffff_ffff, true), "badLength"],
  ["STATUS magic", RecordType.STATUS, 0, (v, p) => v.setUint32(p, 0, true), "badRecord"],
  ["STATUS message kind", RecordType.STATUS, 0, (v, p) => v.setUint16(p + 6, 0xffff, true), "badRecord"],
  ["STATUS body length past its len", RecordType.STATUS, 0, (v, p) => v.setUint32(p + 12, 0, true), "badLength"],
  ["STATUS currentFrame differs from the frame", RecordType.STATUS, 0, (v, p) => v.setFloat64(p + 16, 769, true), "badRecord"],
];

describe("capture decode fuzz (L-Rc1a)", () => {
  it("L-Rc1a: a corrupted value in every header field refuses with its code (§5.1 order: badMagic, newerFormat/olderFormat, wireMismatch, tooLarge, then badHeader/metaTooLarge/tooManyRecords)", async () => {
    for (const [name, edit, code] of HEADER_REFUSALS) {
      const rec = recorder();
      expect(await outcome(edited(sampleCapture(), edit), rec.opts), name).toBe(code);
      // A header refusal happens before any allocation the reader sizes.
      expect(rec.sizes, name).toEqual([]);
    }
    // §5.1 gives ringBytes no domain (any u32 is a valid ring size): the open takes it as it is.
    const big = edited(sampleCapture(), (v) => v.setUint32(80, 0xffff_ffff, true));
    expect(readCaptureHeader(big).ringBytes).toBe(0xffff_ffff);
    expect(await outcome(big)).toBe("opened");
  });

  it("L-Rc1a: every single-byte flip of the 96 B header either opens identically or throws CaptureError (never another error)", async () => {
    const good = sampleCapture();
    const ref = recordsKey(await openCapture(good));
    for (let at = 0; at < CAPTURE_HEADER_BYTES; at++) {
      for (let mask = 1; mask < 256; mask++) {
        const file = edited(good, (v) => v.setUint8(at, v.getUint8(at) ^ mask));
        const got = await outcome(file);
        if (got === "opened") {
          // The flipped byte sat in a field the reader accepts (ringBytes, a flag the decoder doesn't read, a preset): the
          // records must be the ones the file holds.
          expect(recordsKey(await openCapture(file)), `byte ${at} ^ 0x${mask.toString(16)}`).toBe(ref);
        }
      }
    }
  }, 120_000);

  it("L-Rc1a: a corrupted byte in every record head field (type, flags, epoch, len, seq, frame) of every record type throws CaptureError or opens identically", async () => {
    const good = sampleCapture();
    for (const at of recordHeads(good)) {
      const frame = new DataView(good.buffer, good.byteOffset, good.byteLength).getFloat64(at + 12, true);
      for (let k = 0; k < CAPTURE_RECORD_HEAD_BYTES; k++) {
        for (const mask of [0x01, 0x80, 0xff]) {
          const file = edited(good, (v) => v.setUint8(at + k, v.getUint8(at + k) ^ mask));
          const name = `record at ${at}, head byte ${k} ^ 0x${mask.toString(16)}`;
          const got = await outcome(file);
          // Deterministic cases: the type's high bit is unknownRequired, a set unknown flag is badRecord, a len's high bit is
          // past its cap, and a frame made negative is badFrame.
          if (k === 0 && mask === 0x80) expect(got, name).toBe("unknownRequired");
          if (k === 1 && mask === 0x80) expect(got, name).toBe("badRecord");
          if (k === 7 && mask === 0x80) expect(got, name).toBe("recordTooLarge");
          if (k === 19 && mask === 0x80 && frame > 0) expect(got, name).toBe("badFrame");
        }
      }
    }
  });

  it("L-Rc1a: a corrupted enum or count in every record payload (EPOCH reason and rate, GAP reason and order, EVENT kind/reason/argc, MARKER n, NAMES table/n, MIXOP op/class/argc/origin, INDEX count) throws badValue or badLength", async () => {
    for (const [name, type, nth, write, code] of PAYLOAD_REFUSALS) {
      const file = sampleCapture();
      const p = payloadOf(file, nthOf(file, type, nth));
      expect(await outcome(edited(file, (v) => write(v, p))), name).toBe(code);
    }
  });

  it("L-Rc1a: a lying len (one short, one long, past the end) in every record type: badLength or truncatedRecord", async () => {
    const good = sampleCapture();
    const end = good.byteLength;
    const v = new DataView(good.buffer, good.byteOffset, good.byteLength);
    for (const at of recordHeads(good)) {
      const type = good[at]!;
      const len = v.getUint32(at + 4, true);
      const cap = type === RecordType.STATUS ? STATUS_BUFFER_BYTES : CAPTURE_RECORD_MAX_BYTES;
      const pastEnd = end - at - CAPTURE_RECORD_HEAD_BYTES + 1;
      const cases: [label: string, len: number][] = [["one short", len - 1], ["one long", len + 1], ["past the end", pastEnd]];
      for (const [label, n] of cases) {
        const name = `type 0x${type.toString(16)} at ${at}, ${label}`;
        const got = await outcome(edited(good, (x) => x.setUint32(at + 4, n, true)));
        // A len that runs past the records' end (the last record's "one long", or "past the end") is truncatedRecord.
        const runsPastEnd = at + CAPTURE_RECORD_HEAD_BYTES + n > end;
        if (n > cap) expect(got, name).toBe("recordTooLarge");
        else if (runsPastEnd) expect(got, name).toBe("truncatedRecord");
        else if (SELF_CHECKED_TYPES.has(type)) expect(got, name).toBe("badLength");
        // A KEYFRAME (Rc1b's codec is a stub here) and an unknown type frame by len alone: the lie shows at the next head.
        else expect(got, name).not.toBe("opened");
      }
    }
  });

  it("L-Rc1a: a count past its cap (recordCount past uncompressedBytes / 20, EVENT argc, INDEX keyframeCount, 65,537 names) refuses before allocating", async () => {
    const plain = sampleCapture();
    const rec = recorder();
    const perRow = tableCap(plain.byteLength);

    const tooMany = edited(plain, (v) => v.setUint32(72, Math.floor(v.getUint32(68, true) / CAPTURE_RECORD_HEAD_BYTES) + 1, true));
    expect(await outcome(tooMany, rec.opts)).toBe("tooManyRecords");
    expect(rec.sizes).toEqual([]);

    const file = sampleCapture();
    const eventAt = payloadOf(file, nthOf(file, RecordType.EVENT, 0));
    const argcRec = recorder();
    expect(await outcome(edited(file, (v) => v.setUint16(eventAt + 10, 0xffff, true)), argcRec.opts)).toBe("badLength");
    expect(argcRec.max("records")).toBeLessThanOrEqual(perRow);

    const indexAt = payloadOf(file, nthOf(file, RecordType.INDEX, 0));
    const indexRec = recorder();
    expect(await outcome(edited(file, (v) => v.setUint32(indexAt, 0xffff_ffff, true)), indexRec.opts)).toBe("badLength");
    expect(indexRec.max("records")).toBeLessThanOrEqual(perRow);

    // 65,537 names: META's table first, then NAMES records; the 65,537th refuses (65,536 is the most).
    const metaNames: Record<number, string> = {};
    for (let i = 0; i <= CAPTURE_MAX_NAMES; i++) metaNames[i] = "a";
    const metaFile = assembleCapture(SAMPLE_HEADER, encodeCaptureMeta({ ...SAMPLE_META, names: { clips: metaNames } }), []);
    expect(await outcome(metaFile)).toBe("tooManyNames");

    const names = (n: number): CaptureRecordInit[] => {
      const out: CaptureRecordInit[] = [];
      for (let i = 0; i < n; i++) out.push({ type: RecordType.NAMES, epoch: 0, seq: i + 1, frame: 0, payload: { table: 0, id: i, name: "a" } });
      return out;
    };
    const emptyMeta = { ...SAMPLE_META, names: {} };
    const at65536 = recorder();
    expect(await outcome(assembleCapture(SAMPLE_HEADER, emptyMeta, names(CAPTURE_MAX_NAMES)), at65536.opts)).toBe("opened");
    expect(at65536.max("records")).toBeLessThanOrEqual(tableCap(CAPTURE_MAX_NAMES * 31));
    const over = recorder();
    expect(await outcome(assembleCapture(SAMPLE_HEADER, emptyMeta, names(CAPTURE_MAX_NAMES + 1)), over.opts)).toBe("tooManyNames");
    expect(over.max("records")).toBeLessThanOrEqual(tableCap(CAPTURE_MAX_NAMES * 31));
  }, 120_000);

  it("L-Rc1a: 4 GB declared (uncompressedBytes, recordBytes, len 0xffffffff, metaBytes 0xffffffff) refuses from the header with no allocation", async () => {
    const plain = sampleCapture();
    const cases: [name: string, edit: (v: DataView) => void, code: CaptureErrorCode][] = [
      ["uncompressedBytes 4 GB", (v) => v.setUint32(68, 0xffff_ffff, true), "tooLarge"],
      ["recordBytes 4 GB", (v) => v.setUint32(64, 0xffff_ffff, true), "badHeader"],
      ["metaBytes 4 GB", (v) => v.setUint32(60, 0xffff_ffff, true), "metaTooLarge"],
    ];
    for (const [name, edit, code] of cases) {
      const rec = recorder();
      expect(await outcome(edited(plain, edit), rec.opts), name).toBe(code);
      expect(rec.sizes, name).toEqual([]);
    }
    // A record's len of 4 GB is refused by its head, before the record table grows.
    const head = recordHeads(plain)[0]!;
    const lenRec = recorder();
    expect(await outcome(edited(plain, (v) => v.setUint32(head + 4, 0xffff_ffff, true)), lenRec.opts)).toBe("recordTooLarge");
    expect(lenRec.sizes).toEqual([]);
    // A compressed file declaring 4 GB is refused before anything inflates.
    const packed = compress(plain);
    const packedRec = recorder();
    expect(await outcome(edited(packed, (v) => v.setUint32(68, 0xffff_ffff, true)), packedRec.opts)).toBe("tooLarge");
    expect(packedRec.sizes).toEqual([]);
  });

  it("L-Rc1a: a deflate bomb (more than 64 MiB of output, and output past a small declared size) stops at uncompressedBytes + 1 (inflateOverrun)", async () => {
    // The heavy case: the header declares exactly 64 MiB, the stream inflates to about 70 MB of zeros.
    const plain = sampleCapture({ index: false });
    const metaBytes = readCaptureHeader(plain).metaBytes;
    const big = bombFile(plain, deflateRawSync(new Uint8Array(70 * MiB)));
    const v = new DataView(big.buffer);
    v.setUint32(64, CAPTURE_MAX_UNCOMPRESSED_BYTES - metaBytes, true);
    v.setUint32(68, CAPTURE_MAX_UNCOMPRESSED_BYTES, true);
    const heavy = recorder();
    expect(await outcome(big, heavy.opts)).toBe("inflateOverrun");
    expect(heavy.total("inflate")).toBeLessThanOrEqual(CAPTURE_MAX_UNCOMPRESSED_BYTES + heavy.max("inflate"));
    expect(heavy.max("inflate")).toBeLessThanOrEqual(CAPTURE_MAX_UNCOMPRESSED_BYTES);

    // A small declared size: 8 MiB of zeros behind the sample's few hundred bytes.
    const declared = readCaptureHeader(plain).uncompressedBytes;
    const small = recorder();
    expect(await outcome(bombFile(plain, deflateRawSync(new Uint8Array(8 * MiB))), small.opts)).toBe("inflateOverrun");
    expect(small.total("inflate")).toBeLessThanOrEqual(declared + small.max("inflate"));
  }, 120_000);

  it("L-Rc1a: a 10 MB name (in META: metaTooLarge; in NAMES and MARKER: textTooLong or recordTooLarge)", async () => {
    const big = "a".repeat(10 * MiB);
    const metaRec = recorder();
    const meta = new TextEncoder().encode(JSON.stringify({ project: { name: big }, engine: "x", device: { preset: 1, sampleRate: 48_000 }, audio: null, target: null, names: {} }));
    expect(await outcome(assembleCapture(SAMPLE_HEADER, meta, []), metaRec.opts)).toBe("metaTooLarge");
    expect(metaRec.sizes).toEqual([]);

    const namesRec = recorder();
    const bigName = [{ type: RecordType.NAMES, epoch: 0, seq: 1, frame: 0, payload: { table: 0, id: 1, name: big } } as CaptureRecordInit];
    expect(await outcome(assembleCapture(SAMPLE_HEADER, SAMPLE_META, bigName), namesRec.opts)).toBe("recordTooLarge");
    expect(namesRec.sizes).toEqual([]);

    const markerRec = recorder();
    const bigMarker = [{ type: RecordType.MARKER, epoch: 0, seq: 1, frame: 0, payload: { perfMs: 0, text: big } } as CaptureRecordInit];
    expect(await outcome(assembleCapture(SAMPLE_HEADER, SAMPLE_META, bigMarker), markerRec.opts)).toBe("recordTooLarge");
    expect(markerRec.sizes).toEqual([]);

    // Within the record cap but past the text cap: textTooLong.
    const longName = [{ type: RecordType.NAMES, epoch: 0, seq: 1, frame: 0, payload: { table: 0, id: 1, name: "a".repeat(CAPTURE_NAME_MAX_BYTES + 1) } } as CaptureRecordInit];
    expect(await outcome(assembleCapture(SAMPLE_HEADER, SAMPLE_META, longName))).toBe("textTooLong");
    const longMarker = [{ type: RecordType.MARKER, epoch: 0, seq: 1, frame: 0, payload: { perfMs: 0, text: "a".repeat(CAPTURE_MARKER_MAX_BYTES + 1) } } as CaptureRecordInit];
    expect(await outcome(assembleCapture(SAMPLE_HEADER, SAMPLE_META, longMarker))).toBe("textTooLong");
  });

  it("L-Rc1a: invalid UTF-8 in META, MARKER and NAMES: badUtf8", async () => {
    // META: the S of "Sample" becomes 0xff.
    const meta = encodeCaptureMeta(SAMPLE_META);
    meta[new TextDecoder().decode(meta).indexOf("Sample")] = 0xff;
    expect(await outcome(assembleCapture(SAMPLE_HEADER, meta, []))).toBe("badUtf8");

    // MARKER: a text of two bytes, 0xc3 0x28 (a truncated two-byte sequence).
    const marker = new Uint8Array(12);
    new DataView(marker.buffer).setUint16(8, 2, true);
    marker.set([0xc3, 0x28], 10);
    expect(await outcome(assembleCapture(SAMPLE_HEADER, SAMPLE_META, [{ type: RecordType.MARKER, epoch: 0, seq: 1, frame: 0, payload: marker }]))).toBe("badUtf8");

    // NAMES: a name of two bytes, 0xff 0xfe.
    const names = new Uint8Array(12);
    const nv = new DataView(names.buffer);
    nv.setUint32(4, 1, true);
    nv.setUint16(8, 2, true);
    names.set([0xff, 0xfe], 10);
    expect(await outcome(assembleCapture(SAMPLE_HEADER, SAMPLE_META, [{ type: RecordType.NAMES, epoch: 0, seq: 1, frame: 0, payload: names }]))).toBe("badUtf8");
  });

  it("L-Rc1a: an unknown required type (0x80..0xFF) is unknownRequired; an unknown type below 0x80 is skipped", async () => {
    const at = sampleRecords().findIndex((r) => r.type === 0x40);
    for (const type of [0x80, 0xa5, 0xff]) {
      const recs = sampleRecords();
      recs[at] = { type, epoch: 0, seq: recs[at]!.seq, frame: 1400, payload: new Uint8Array([1, 2, 3]) } as CaptureRecordInit;
      expect(await outcome(assembleCapture(SAMPLE_HEADER, SAMPLE_META, recs)), `type 0x${type.toString(16)}`).toBe("unknownRequired");
    }
    // The sample's WRAP refusal is a badRecord, not unknownRequired (the saver strips WRAP).
    const wrap = sampleRecords();
    wrap[at] = { type: RecordType.WRAP, epoch: 0, seq: wrap[at]!.seq, frame: 1400, payload: new Uint8Array(0) } as CaptureRecordInit;
    expect(await outcome(assembleCapture(SAMPLE_HEADER, SAMPLE_META, wrap))).toBe("badRecord");

    // Types 0x10, 0x40 and 0x7e are skipped by len and read back as unknown records.
    for (const type of [0x10, 0x40, 0x7e]) {
      const recs = sampleRecords();
      recs[at] = { type, epoch: 0, seq: recs[at]!.seq, frame: 1400, payload: new Uint8Array([1, 2, 3]) } as CaptureRecordInit;
      const c = await openCapture(assembleCapture(SAMPLE_HEADER, SAMPLE_META, recs));
      expect(decodeRecordAt(c, at).kind, `type 0x${type.toString(16)}`).toBe("unknown");
    }
  });

  it("L-Rc1a: truncation at every byte boundary of a whole file throws CaptureError", async () => {
    const stored = sampleCapture();
    for (let n = 0; n < stored.byteLength; n++) {
      expect(await outcome(stored.slice(0, n)), `stored, ${n} B`).not.toBe("opened");
    }
    const packed = compress(stored);
    for (let n = 0; n < packed.byteLength; n++) {
      expect(await outcome(packed.slice(0, n)), `compressed, ${n} B`).not.toBe("opened");
    }
  });

  it("L-Rc1a: a seeded random fuzz (fixed seed, 2,000 mutations) throws only CaptureError and never allocates past the caps", async () => {
    const rnd = mulberry32(0x5eed);
    const bases = [sampleCapture(), compress(sampleCapture())];
    const seen = new Set<Outcome>();
    for (let k = 0; k < 2_000; k++) {
      const base = bases[k % 2]!;
      const file = mutateOnce(base, rnd);
      const rec = recorder();
      seen.add(await outcome(file, rec.opts));
      // Every table grows by the records the payload can hold, and inflate stops at the 64 MiB cap (+1 chunk).
      expect(rec.max("records"), `mutation ${k}`).toBeLessThanOrEqual(tableCap(Math.max(file.byteLength, rec.total("inflate"))));
      expect(rec.total("inflate"), `mutation ${k}`).toBeLessThanOrEqual(CAPTURE_MAX_UNCOMPRESSED_BYTES + rec.max("inflate"));
    }
    // The mutations reach many refusals, not one.
    expect(seen.size).toBeGreaterThan(5);
  }, 120_000);
});

/** A comparable key for an open's records: their count, and each record's type, flags, epoch, seq, frame and len. */
function recordsKey(c: { records: RecordTable }): string {
  const t = c.records;
  const n = t.count;
  return JSON.stringify([n, Array.from(t.type.subarray(0, n)), Array.from(t.flags.subarray(0, n)), Array.from(t.epoch.subarray(0, n)),
    Array.from(t.seq.subarray(0, n)), Array.from(t.frame.subarray(0, n)), Array.from(t.len.subarray(0, n))]);
}
