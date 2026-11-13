// ADR 0171/0172 (Rc1, leaf L-Rc1c; api-and-models §5.3, §5.4, §6.2): golden byte vectors per record type, in
// `capture/__fixtures__/records.json` (head and payload hex, hand-assembled from the spec table, and the decoded fields).
// Each vector decodes to its fields and encodes back to its bytes; the whole-file vector (`__fixtures__/sample.mycap`,
// stored, with INDEX) opens, every record round-trips, and `assembleCapture` rebuilds it byte-equal.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeMixOp } from "../../../../engine/audio/mixOps";
import { MAGIC, SCHEMA_HASH, STATUS_BUFFER_BYTES, STATUS_HEADER_BYTES } from "../wire.generated";
import {
  CAPTURE_FLAG_COMPRESSED,
  CAPTURE_FLAG_HAS_INDEX,
  CAPTURE_RECORD_HEAD_BYTES,
  DEFERRED_STAMP_BYTES,
  RECORD_FLAG_DEFERRED,
  RecordType,
  assembleCapture,
  checkStatusPayload,
  decodeEpoch,
  decodeEvent,
  decodeGap,
  decodeIndex,
  decodeMarker,
  decodeMixOpRecord,
  decodeNames,
  encodeRecord,
  readRecordHead,
  recordPayloadBytes,
  type CaptureRecordInit,
} from "./format";
import { decodeRecordAt, openCapture } from "./reader";
import { SAMPLE_HEADER, SAMPLE_META, sampleRecords } from "./testSupport";
import fixtures from "./__fixtures__/records.json";

interface Expect {
  type: number;
  flags: number;
  epoch: number;
  seq: number;
  frame: number;
  stamp?: number;
  payload?: Record<string, unknown>;
  envelope?: { kind: number; version: number; seq: number; bodyBytes: number; currentFrame: number };
}
interface Vector {
  group: string;
  name: string;
  head: string;
  payload: string;
  expect: Expect;
}

const vectors = (fixtures as unknown as { records: Vector[] }).records;
const group = (g: string): Vector[] => vectors.filter((v) => v.group === g);
const EVENT_F32_KINDS = [1, 11, 14, 18];

/** Hex (spaces allowed) to bytes. */
function bytesOf(hex: string): Uint8Array {
  const s = hex.replace(/\s+/g, "");
  if (s.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(s)) throw new Error(`not hex: ${hex.slice(0, 40)}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** The record's golden bytes: the 20 B head, then the payload. */
function golden(v: Vector): Uint8Array {
  const head = bytesOf(v.head);
  const payload = bytesOf(v.payload);
  expect(head.length, `${v.name}: head is 20 B`).toBe(CAPTURE_RECORD_HEAD_BYTES);
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}

/** `{ repeat, count }` expands to the repeated string; anything else passes through. */
function expandText(x: unknown): unknown {
  if (typeof x === "object" && x !== null && "repeat" in x) {
    const r = x as { repeat: string; count: number };
    return r.repeat.repeat(r.count);
  }
  return x;
}

/** The expected payload as the decoder returns it: text expanded, MIXOP words numbers. */
function expectedPayload(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...p };
  if ("text" in p) out.text = expandText(p.text);
  if ("name" in p) out.name = expandText(p.name);
  if (Array.isArray(p.words)) out.words = (p.words as string[]).map(Number);
  return out;
}

/** A decoded value as plain data (typed arrays become arrays). */
function plain<T>(x: T): T {
  return JSON.parse(JSON.stringify(x, (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v)));
}

/** Decodes one record's bytes (head and payload) with the record codecs. */
function decodeVector(bytes: Uint8Array): { head: ReturnType<typeof readRecordHead>; stamp: number | undefined; payload: unknown } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = readRecordHead(view, 0, bytes.byteLength, STATUS_BUFFER_BYTES);
  expect(head.len).toBe(bytes.byteLength - CAPTURE_RECORD_HEAD_BYTES);
  const deferred = (head.flags & RECORD_FLAG_DEFERRED) !== 0;
  const stamp = deferred ? view.getFloat64(CAPTURE_RECORD_HEAD_BYTES, true) : undefined;
  const off = CAPTURE_RECORD_HEAD_BYTES + (deferred ? DEFERRED_STAMP_BYTES : 0);
  const len = head.len - (deferred ? DEFERRED_STAMP_BYTES : 0);
  let payload: unknown;
  switch (head.type) {
    case RecordType.EPOCH: payload = decodeEpoch(view, off, len); break;
    case RecordType.GAP: payload = decodeGap(view, off, len); break;
    case RecordType.STATUS:
      checkStatusPayload(view, off, len, head.frame);
      payload = bytes.subarray(off, off + len);
      break;
    case RecordType.EVENT: payload = decodeEvent(view, off, len); break;
    case RecordType.MARKER: payload = decodeMarker(view, off, len); break;
    case RecordType.NAMES: payload = decodeNames(view, off, len); break;
    case RecordType.MIXOP: payload = decodeMixOpRecord(view, off, len); break;
    case RecordType.INDEX: payload = decodeIndex(view, off, len); break;
    default: throw new Error(`no codec for record type 0x${head.type.toString(16)}`);
  }
  return { head, stamp, payload: plain(payload) };
}

/** Encodes a vector's expected fields with `encodeRecord`. */
function encodeVector(v: Vector): Uint8Array {
  const e = v.expect;
  let payload: unknown;
  if (e.type === RecordType.STATUS) payload = bytesOf(v.payload);
  else {
    const p = expectedPayload(e.payload!);
    payload = e.type === RecordType.MIXOP ? { ...p, words: Uint32Array.from(p.words as number[]) } : p;
  }
  const init = {
    type: e.type, epoch: e.epoch, seq: e.seq, frame: e.frame,
    ...(e.stamp !== undefined ? { stamp: e.stamp } : {}),
    payload,
  } as unknown as CaptureRecordInit;
  const out = new Uint8Array(CAPTURE_RECORD_HEAD_BYTES + recordPayloadBytes(init));
  expect(encodeRecord(new DataView(out.buffer), 0, init), `${v.name}: encoded length`).toBe(out.byteLength);
  return out;
}

function checkEnvelope(bytes: Uint8Array, e: NonNullable<Expect["envelope"]>, name: string): void {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = CAPTURE_RECORD_HEAD_BYTES;
  expect(bytes.byteLength - at, `${name}: a STATUS block is ${STATUS_HEADER_BYTES} B`).toBe(STATUS_HEADER_BYTES);
  expect(dv.getUint32(at, true), `${name}: wire magic`).toBe(MAGIC);
  expect(dv.getUint16(at + 4, true), `${name}: envelope version`).toBe(e.version);
  expect(dv.getUint16(at + 6, true), `${name}: envelope kind`).toBe(e.kind);
  expect(dv.getUint32(at + 8, true), `${name}: envelope seq`).toBe(e.seq);
  expect(dv.getUint32(at + 12, true), `${name}: bodyBytes`).toBe(e.bodyBytes);
  expect(dv.getFloat64(at + 16, true), `${name}: currentFrame`).toBe(e.currentFrame);
}

/** One vector: its head and payload decode to the expected fields, and the fields encode back to the golden bytes. */
function checkVector(v: Vector): void {
  const bytes = golden(v);
  const d = decodeVector(bytes);
  const e = v.expect;
  expect({ type: d.head.type, flags: d.head.flags, epoch: d.head.epoch, seq: d.head.seq, frame: d.head.frame }, `${v.name}: head`)
    .toEqual({ type: e.type, flags: e.flags, epoch: e.epoch, seq: e.seq, frame: e.frame });
  expect(d.stamp, `${v.name}: deferred stamp`).toBe(e.stamp);
  if (e.payload) expect(d.payload, `${v.name}: payload`).toEqual(expectedPayload(e.payload));
  if (e.envelope) checkEnvelope(bytes, e.envelope, v.name);
  expect(Array.from(encodeVector(v)), `${v.name}: re-encoded bytes`).toEqual(Array.from(bytes));
}

describe("capture record vectors (L-Rc1c)", () => {
  it("L-Rc1c: EPOCH vector (every reason 0..6) decodes and re-encodes byte-equal", () => {
    const vs = group("EPOCH");
    expect(vs.map((v) => v.expect.payload!.reason)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    vs.forEach((v) => checkVector(v));
  });

  it("L-Rc1c: GAP vector (every reason 1..5) decodes and re-encodes byte-equal", () => {
    const vs = group("GAP");
    expect(vs.map((v) => v.expect.payload!.reason)).toEqual([1, 2, 3, 4, 5]);
    vs.forEach((v) => checkVector(v));
  });

  it("L-Rc1c: STATUS vector (a real wire block) frames, checks and re-encodes byte-equal", () => {
    const vs = group("STATUS");
    expect(vs.length).toBe(1);
    checkVector(vs[0]!);
  });

  it("L-Rc1c: EVENT vectors (one per kind 1..19, f32 present exactly for 1, 11, 14, 18) decode and re-encode byte-equal", () => {
    const vs = group("EVENT");
    expect(vs.map((v) => v.expect.payload!.kind)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
    for (const v of vs) {
      const kind = v.expect.payload!.kind as number;
      const f32 = EVENT_F32_KINDS.includes(kind);
      expect(v.expect.payload !== undefined && "f32" in v.expect.payload, `${v.name}: f32 in the fields`).toBe(f32);
      checkVector(v);
      expect("f32" in (decodeVector(golden(v)).payload as object), `${v.name}: f32 decoded`).toBe(f32);
    }
  });

  it("L-Rc1c: MARKER vectors (empty, ASCII, multi-byte UTF-8 at 120 B) decode and re-encode byte-equal", () => {
    const vs = group("MARKER");
    expect(vs.length).toBe(3);
    vs.forEach((v) => checkVector(v));
    const multi = expectedPayload(vs[2]!.expect.payload!).text as string;
    expect(new TextEncoder().encode(multi).byteLength).toBe(120);
  });

  it("L-Rc1c: NAMES vectors (every table 0..5, a 256 B name) decode and re-encode byte-equal", () => {
    const vs = group("NAMES");
    expect(vs.map((v) => v.expect.payload!.table)).toEqual([0, 1, 2, 3, 4, 5, 5]);
    vs.forEach((v) => checkVector(v));
    const long = expectedPayload(vs[6]!.expect.payload!).name as string;
    expect(new TextEncoder().encode(long).byteLength).toBe(256);
  });

  it("L-Rc1c: MIXOP vector (from encodeMixOp of a real op) decodes and re-encodes byte-equal", () => {
    const [v] = group("MIXOP");
    const names = {
      nameId: (n: string): number => { throw new Error(`unexpected name ${n}`); },
      busRef: (b: string): number => { expect(b).toBe("Music"); return 0x101; },
    };
    const bytes = encodeMixOp({ op: "setBus", bus: "Music", key: "volume", value: 0.5 }, "direct", names);
    expect(bytes.op).toBe(0);
    expect(bytes.class).toBe(0);
    expect(Array.from(bytes.words)).toEqual(expectedPayload(v!.expect.payload!).words);
    checkVector(v!);
  });

  it("L-Rc1c: INDEX vector (0 and 2 entries) decodes and re-encodes byte-equal", () => {
    const vs = group("INDEX");
    expect(vs.map((v) => (v.expect.payload!.entries as unknown[]).length)).toEqual([0, 2]);
    vs.forEach((v) => checkVector(v));
  });

  it("L-Rc1c: a deferred record vector (stamp first in the payload) decodes and re-encodes byte-equal", () => {
    const [v] = group("DEFERRED");
    expect(v!.expect.flags).toBe(RECORD_FLAG_DEFERRED);
    expect(v!.expect.stamp).toBe(200000);
    checkVector(v!);
  });

  it("L-Rc1c: the whole-file vector opens, every record round-trips, and assembleCapture rebuilds it byte-equal", async () => {
    const file = new Uint8Array(readFileSync(new URL("./__fixtures__/sample.mycap", import.meta.url)));
    // The fixture's header carries the wire SCHEMA_HASH it was assembled under; a schema change elsewhere must not
    // break this vector, so the current hash is stamped over it (header bytes 12..28, §5.1) before anything reads it.
    for (let i = 0; i < 16; i++) file[12 + i] = parseInt(SCHEMA_HASH.slice(2 * i, 2 * i + 2), 16);
    const c = await openCapture(file);
    expect(c.header.recordCount).toBe(16);
    expect(c.header.flags & CAPTURE_FLAG_COMPRESSED).toBe(0);
    expect(c.header.flags & CAPTURE_FLAG_HAS_INDEX).toBe(CAPTURE_FLAG_HAS_INDEX);
    expect(c.records.count).toBe(16);
    expect(c.index).not.toBeNull();
    expect(c.keyframes.length).toBe(2);
    for (let i = 0; i < c.records.count; i++) {
      const r = decodeRecordAt(c, i);
      const deferred = (c.records.flags[i]! & RECORD_FLAG_DEFERRED) !== 0;
      const end = c.records.offset[i]! + c.records.len[i]!;
      const start = c.records.offset[i]! - CAPTURE_RECORD_HEAD_BYTES - (deferred ? DEFERRED_STAMP_BYTES : 0);
      const seg = c.segments[c.records.segment[i]!]!;
      const init = {
        type: r.type, epoch: r.epoch, seq: r.seq, frame: r.frame,
        ...(r.stamp !== undefined ? { stamp: r.stamp } : {}),
        payload: r.payload,
      } as unknown as CaptureRecordInit;
      const out = new Uint8Array(CAPTURE_RECORD_HEAD_BYTES + recordPayloadBytes(init));
      encodeRecord(new DataView(out.buffer), 0, init);
      expect(Array.from(out), `record ${i} (type 0x${r.type.toString(16)}) round-trips`).toEqual(Array.from(seg.subarray(start, end)));
    }
    expect(Array.from(assembleCapture(SAMPLE_HEADER, SAMPLE_META, sampleRecords(), { index: true }))).toEqual(Array.from(file));
  });
});
