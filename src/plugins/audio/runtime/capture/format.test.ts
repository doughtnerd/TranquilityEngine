// ADR 0171/0172 (Rc1; api-and-models §5.1-§5.4): the header and every record codec round-trip; the header refuses in
// §5.1's order. The fuzz and bombs are format.fuzz.test.ts (L-Rc1a); the vectors format.vectors.test.ts (L-Rc1c).
import { describe, expect, it } from "vitest";
import { MIX_OP_NAMES, OP_CLASSES } from "../../../../engine/audio/mixOps";
import { CORE_ABI_MAJOR } from "../worklet/coreDriver";
import { SCHEMA_HASH } from "../wire.generated";
import {
  CAPTURE_ABI_VERSION, CAPTURE_HEADER_BYTES, CAPTURE_MIXOP_CLASSES, CAPTURE_MIXOP_CODES, CaptureError, RecordType,
  cutUtf8, decodeCaptureMeta, decodeEpoch, decodeEvent, decodeGap, decodeIndex, decodeMarker, decodeMixOpRecord, decodeNames,
  encodeCaptureMeta, encodeEpoch, encodeEvent, encodeGap, encodeIndex, encodeMarker, encodeMixOpRecord, encodeNames,
  eventBytes, indexBytes, markerBytes, mixOpBytes, namesBytes, readCaptureHeader, readRecordHead, writeRecordHead,
  type CaptureErrorCode,
} from "./format";
import { SAMPLE_META, sampleCapture } from "./testSupport";

function codeOf(f: () => unknown): CaptureErrorCode | "none" {
  try {
    f();
  } catch (e) {
    if (e instanceof CaptureError) return e.code;
    throw e;
  }
  return "none";
}

function roundTrip<T>(bytes: number, enc: (v: DataView, off: number) => number, dec: (v: DataView, off: number, len: number) => T): T {
  const buf = new Uint8Array(bytes + 3);
  const view = new DataView(buf.buffer);
  expect(enc(view, 3)).toBe(bytes);
  return dec(view, 3, bytes);
}

describe("capture format constants", () => {
  it("names this build's ABI and the mix-op code counts", () => {
    expect(CAPTURE_ABI_VERSION).toBe(CORE_ABI_MAJOR << 8);
    expect(CAPTURE_MIXOP_CODES).toBe(MIX_OP_NAMES.length);
    expect(CAPTURE_MIXOP_CLASSES).toBe(OP_CLASSES.length);
  });
});

describe("capture header (§5.1)", () => {
  it("round-trips through assembleCapture", () => {
    const file = sampleCapture();
    const h = readCaptureHeader(file);
    expect(h.schemaHash).toBe(SCHEMA_HASH);
    expect(h.sampleRate).toBe(48_000);
    expect(h.metaBytes + h.recordBytes).toBe(file.byteLength - CAPTURE_HEADER_BYTES);
    expect(h.recordCount).toBe(16);
  });

  it("refuses in §5.1's order: magic, format, hash, size", () => {
    const file = sampleCapture();
    expect(codeOf(() => readCaptureHeader(file.subarray(0, 95)))).toBe("badMagic");
    const v = (f: (d: DataView) => void) => { const c = file.slice(); f(new DataView(c.buffer)); return c; };
    expect(codeOf(() => readCaptureHeader(v((d) => d.setUint8(0, 0))))).toBe("badMagic");
    expect(codeOf(() => readCaptureHeader(v((d) => d.setUint16(8, 2, true))))).toBe("newerFormat");
    expect(codeOf(() => readCaptureHeader(v((d) => d.setUint16(8, 0, true))))).toBe("olderFormat");
    // Every later field is bad too: the first step still wins.
    const all = v((d) => { d.setUint8(12, d.getUint8(12) ^ 1); d.setUint32(68, 0xffffffff, true); });
    expect(codeOf(() => readCaptureHeader(all))).toBe("wireMismatch");
    expect(codeOf(() => readCaptureHeader(v((d) => d.setUint32(68, 64 * 1024 * 1024 + 1, true))))).toBe("tooLarge");
    expect(codeOf(() => readCaptureHeader(v((d) => d.setUint32(84, 1, true))))).toBe("badHeader");
  });

  it("names both ABI versions on a wire mismatch", () => {
    const c = sampleCapture().slice();
    c[12] ^= 0xff;
    expect(() => readCaptureHeader(c)).toThrow(/ABI 4\.0.*re-record with this build/);
  });
});

describe("record framing (§5.3)", () => {
  it("round-trips a head", () => {
    const view = new DataView(new ArrayBuffer(40));
    writeRecordHead(view, 0, { type: 5, flags: 1, epoch: 3, len: 20, seq: 99, frame: 1234.5 });
    expect(readRecordHead(view, 0, 40, 20480)).toEqual({ type: 5, flags: 1, epoch: 3, len: 20, seq: 99, frame: 1234.5 });
  });
  it("refuses len before anything sized by it", () => {
    const view = new DataView(new ArrayBuffer(20));
    writeRecordHead(view, 0, { type: RecordType.EVENT, flags: 0, epoch: 0, len: 0xffffffff, seq: 1, frame: 0 });
    expect(codeOf(() => readRecordHead(view, 0, 20, 20480))).toBe("recordTooLarge");
    writeRecordHead(view, 0, { type: RecordType.STATUS, flags: 0, epoch: 0, len: 20481, seq: 1, frame: 0 });
    expect(codeOf(() => readRecordHead(view, 0, 20, 20480))).toBe("recordTooLarge");
    writeRecordHead(view, 0, { type: 0x80, flags: 0, epoch: 0, len: 0, seq: 1, frame: 0 });
    expect(codeOf(() => readRecordHead(view, 0, 20, 20480))).toBe("unknownRequired");
  });
});

describe("record codecs round-trip (§5.3, §5.4)", () => {
  it("EPOCH", () => {
    const p = { reason: 6, sampleRate: 44_100, limiterLatencyFrames: 64, outputLatencyFrames: 441, timeOffset: 12.5, perfMs: 3.25 };
    expect(roundTrip(32, (v, o) => encodeEpoch(v, o, p), decodeEpoch)).toEqual(p);
  });
  it("GAP", () => {
    const p = { reason: 4, perfFrom: 10, perfTo: 20, firstSeq: 5, lastSeq: 9 };
    expect(roundTrip(28, (v, o) => encodeGap(v, o, p), decodeGap)).toEqual(p);
  });
  it("EVENT with and without its f32", () => {
    const a = { perfMs: 1.5, kind: 14, reason: 0, args: [0x0102, 3, 4800], f32: 0.25 };
    expect(roundTrip(eventBytes(a), (v, o) => encodeEvent(v, o, a), decodeEvent)).toEqual(a);
    const b = { perfMs: 2, kind: 3, reason: 3, args: [1, 2] };
    expect(roundTrip(eventBytes(b), (v, o) => encodeEvent(v, o, b), decodeEvent)).toEqual(b);
  });
  it("MARKER", () => {
    const p = { perfMs: 9, text: "Compare ⇄ swap" };
    expect(roundTrip(markerBytes(p), (v, o) => encodeMarker(v, o, p), decodeMarker)).toEqual(p);
  });
  it("NAMES", () => {
    const p = { table: 5, id: 0xfffffffe, name: "Broadcast EBU R128" };
    expect(namesBytes(p)).toBe(10 + 18);
    expect(roundTrip(namesBytes(p), (v, o) => encodeNames(v, o, p), decodeNames)).toEqual(p);
  });
  it("MIXOP", () => {
    const p = { op: 16, class: 3, words: Uint32Array.from([0, 1]), perfMs: 7, origin: 4 };
    expect(roundTrip(mixOpBytes(p), (v, o) => encodeMixOpRecord(v, o, p), decodeMixOpRecord)).toEqual(p);
  });
  it("INDEX", () => {
    const p = { entries: [{ epoch: 0, frame: 768, byteOffset: 52, seq: 2 }, { epoch: 1, frame: 48768, byteOffset: 9000, seq: 70 }], truncatedFromSeq: 1 };
    expect(roundTrip(indexBytes(p), (v, o) => encodeIndex(v, o, p), decodeIndex)).toEqual(p);
  });
});

describe("META (§5.2)", () => {
  it("round-trips, names in Maps", () => {
    const m = decodeCaptureMeta(encodeCaptureMeta(SAMPLE_META));
    expect(m.project).toEqual({ name: "Sample", version: "1.0.0" });
    expect(m.names.buses.get(1)).toBe("Music");
    expect(m.names.clips.get(1)).toBe("jump.ogg");
    expect(m.device.deviceMemory).toBe(8);
    expect(m.audio).toEqual({ buses: [{ name: "Music" }] });
  });
  it("cuts names to 256 bytes on a code-point boundary", () => {
    const long = "é".repeat(200);
    const m = decodeCaptureMeta(new TextEncoder().encode(JSON.stringify({ project: {}, device: { preset: 1, sampleRate: 48000 }, names: { clips: { 0: long } } })));
    const cut = m.names.clips.get(0)!;
    expect(new TextEncoder().encode(cut).byteLength).toBe(256);
    expect(cut).toBe(cutUtf8(long, 256));
  });
  it("refuses what isn't the shape", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(codeOf(() => decodeCaptureMeta(enc("[1]")))).toBe("badMeta");
    expect(codeOf(() => decodeCaptureMeta(enc("{")))).toBe("badMeta");
    expect(codeOf(() => decodeCaptureMeta(new Uint8Array([0x7b, 0xff, 0x7d])))).toBe("badUtf8");
    expect(codeOf(() => decodeCaptureMeta(enc('{"project":{},"device":{"preset":1,"sampleRate":48000},"names":{"clips":{"x":"a"}}}')))).toBe("badMeta");
  });
});
