// ADR 0171/0172 (Rc1; api-and-models §5.1-§5.4): the header and every record codec round-trip; the header refuses in
// §5.1's order. The fuzz and bombs are format.fuzz.test.ts (L-Rc1a); the vectors format.vectors.test.ts (L-Rc1c).
import { describe, expect, it } from "vitest";
import { MIX_OP_NAMES, OP_CLASSES } from "../../../../engine/audio/mixOps";
import { CORE_ABI_MAJOR } from "../worklet/coreDriver";
import { CORE_ABI_VERSION, SCHEMA_HASH } from "../wire.generated";
import {
  assembleCapture, CAPTURE_ABI_VERSION, CAPTURE_FORMAT_MINOR, CAPTURE_HEADER_BYTES, CAPTURE_MIXOP_CLASSES, CAPTURE_MIXOP_CODES, CaptureError, RecordType,
  cutUtf8, decodeCaptureMeta, decodeEpoch, decodeEvent, decodeGap, decodeIndex, decodeMarker, decodeMixOpRecord, decodeNames,
  encodeCaptureMeta, encodeEpoch, encodeEvent, encodeGap, encodeIndex, encodeMarker, encodeMixOpRecord, encodeNames,
  eventBytes, indexBytes, markerBytes, mixOpBytes, namesBytes, readCaptureHeader, readRecordHead, splitCaptureRecords, writeRecordHead,
  type CaptureErrorCode,
} from "./format";
import { SAMPLE_HEADER, SAMPLE_META, sampleCapture } from "./testSupport";

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
    expect(CAPTURE_ABI_VERSION >> 8).toBe(CORE_ABI_MAJOR); // ABI 6.1 (ADR 0362): the minor is in the low byte
    expect(CAPTURE_ABI_VERSION).toBe(CORE_ABI_VERSION);
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
    expect(codeOf(() => readCaptureHeader(v((d) => d.setUint16(8, 3, true))))).toBe("newerFormat");
    expect(codeOf(() => readCaptureHeader(v((d) => d.setUint16(8, 1, true))))).toBe("olderFormat"); // ADR 0348: format 1 is refused
    expect(codeOf(() => readCaptureHeader(v((d) => d.setUint16(8, 0, true))))).toBe("olderFormat");
    // Every later field is bad too: the first step still wins.
    const all = v((d) => { d.setUint8(12, d.getUint8(12) ^ 1); d.setUint32(68, 0xffffffff, true); });
    expect(codeOf(() => readCaptureHeader(all))).toBe("wireMismatch");
    expect(codeOf(() => readCaptureHeader(v((d) => d.setUint32(68, 64 * 1024 * 1024 + 1, true))))).toBe("tooLarge");
    expect(codeOf(() => readCaptureHeader(v((d) => d.setUint16(86, 1, true))))).toBe("badHeader");
    // ADR 0386: header bytes 84..86 are the format's minor; a newer one is refused up front, an older one reads.
    expect(codeOf(() => readCaptureHeader(v((d) => d.setUint16(84, CAPTURE_FORMAT_MINOR + 1, true))))).toBe("newerFormat");
    expect(readCaptureHeader(v((d) => d.setUint16(84, 0, true))).formatMinor).toBe(0);
    expect(readCaptureHeader(file).formatMinor).toBe(CAPTURE_FORMAT_MINOR);
  });

  it("stamps the running core's ABI the writer gives, and this build's without one (ADR 0328)", () => {
    expect(readCaptureHeader(assembleCapture({ ...SAMPLE_HEADER, abiVersion: CORE_ABI_VERSION }, SAMPLE_META, [])).abiVersion).toBe(CORE_ABI_VERSION);
    expect(readCaptureHeader(assembleCapture(SAMPLE_HEADER, SAMPLE_META, [])).abiVersion).toBe(CAPTURE_ABI_VERSION);
    // A core of another ABI major is refused as a version (ADR 0386), whatever its hash; another minor under this hash reads.
    expect(codeOf(() => readCaptureHeader(assembleCapture({ ...SAMPLE_HEADER, abiVersion: CORE_ABI_VERSION + 0x100 }, SAMPLE_META, [])))).toBe("newerFormat");
    expect(codeOf(() => readCaptureHeader(assembleCapture({ ...SAMPLE_HEADER, abiVersion: CORE_ABI_VERSION - 0x100 }, SAMPLE_META, [])))).toBe("olderFormat");
    expect(readCaptureHeader(assembleCapture({ ...SAMPLE_HEADER, abiVersion: CORE_ABI_VERSION + 1 }, SAMPLE_META, [])).abiVersion).toBe(CORE_ABI_VERSION + 1);
  });

  it("opens a file recorded under an older core ABI minor (another wire hash): a minor bump is backward compatible", () => {
    const older = (CORE_ABI_VERSION & ~0xff) | Math.max(0, (CORE_ABI_VERSION & 0xff) - 1);
    const c = assembleCapture({ ...SAMPLE_HEADER, abiVersion: older === CORE_ABI_VERSION ? CORE_ABI_VERSION + 1 : older }, SAMPLE_META, []).slice();
    for (let i = 12; i < 28; i++) c[i] = c[i]! ^ 0x5a; // that build's own wire hash
    const h = readCaptureHeader(c);
    expect(h.abiVersion >> 8).toBe(CORE_ABI_VERSION >> 8);
    expect(h.schemaHash).not.toBe(SCHEMA_HASH);
    // An older major under another hash is refused as a version (ADR 0386); this very version under another hash is a wire mismatch.
    const major = c.slice();
    new DataView(major.buffer).setUint32(28, CORE_ABI_VERSION - 0x100, true);
    expect(codeOf(() => readCaptureHeader(major))).toBe("olderFormat");
    const same = c.slice();
    new DataView(same.buffer).setUint32(28, CORE_ABI_VERSION, true);
    expect(codeOf(() => readCaptureHeader(same))).toBe("wireMismatch");
  });

  it("opens a file under an older envelope minor and refuses a newer one", () => {
    const c = sampleCapture().slice();
    new DataView(c.buffer).setUint16(34, 0, true);
    expect(readCaptureHeader(c).envelopeMinor).toBe(0);
    new DataView(c.buffer).setUint16(34, 99, true);
    expect(codeOf(() => readCaptureHeader(c))).toBe("newerFormat"); // ADR 0386: newer, not damaged
    expect(() => readCaptureHeader(c)).toThrow(/incompatible version: file is status envelope \d+\.99, this build reads \d+\.0\u2013\d+\.\d+/);
  });

  it("refuses a file from a newer core ABI minor under another wire hash as newerFormat, naming both versions (ADR 0386)", () => {
    const newer = CORE_ABI_VERSION + 1;
    const c = assembleCapture({ ...SAMPLE_HEADER, abiVersion: newer }, SAMPLE_META, []).slice();
    for (let i = 12; i < 28; i++) c[i] = c[i]! ^ 0x5a; // the newer build's own wire hash
    expect(codeOf(() => readCaptureHeader(c))).toBe("newerFormat");
    const reads = `${CORE_ABI_VERSION >> 8}\\.0\u2013${CORE_ABI_VERSION >> 8}\\.${CORE_ABI_VERSION & 0xff}`;
    const theirs = `${newer >> 8}\\.${newer & 0xff}`;
    expect(() => readCaptureHeader(c)).toThrow(new RegExp(`incompatible version: file is audio core ABI ${theirs}, this build reads ${reads}`));
  });

  it("names both ABI versions on a wire mismatch", () => {
    const c = sampleCapture().slice();
    c[12] ^= 0xff;
    expect(() => readCaptureHeader(c)).toThrow(new RegExp(`ABI ${CORE_ABI_VERSION >> 8}\\.${CORE_ABI_VERSION & 0xff}.*re-record with this build`));
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
  it("ADR 0348: a replay capture's replayOf round-trips; absent or malformed it reads as null, never a refusal", () => {
    expect(decodeCaptureMeta(encodeCaptureMeta(SAMPLE_META)).replayOf).toBeNull();
    const replayOf = { path: "takes/canyon_run_01.sporesample", audioHash: "5f3a90c1" };
    expect(decodeCaptureMeta(encodeCaptureMeta({ ...SAMPLE_META, replayOf })).replayOf).toEqual(replayOf);
    const base = { project: {}, device: { preset: 1, sampleRate: 48000 }, names: {} };
    const read = (v: unknown) => decodeCaptureMeta(new TextEncoder().encode(JSON.stringify({ ...base, replayOf: v }))).replayOf;
    expect(read({ path: 3, audioHash: "x" })).toBeNull();
    expect(read("takes/a.sporesample")).toBeNull();
    expect(read({ path: "a".repeat(2000), audioHash: "h" })!.path).toHaveLength(1024);
  });
  it("refuses what isn't the shape", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(codeOf(() => decodeCaptureMeta(enc("[1]")))).toBe("badMeta");
    expect(codeOf(() => decodeCaptureMeta(enc("{")))).toBe("badMeta");
    expect(codeOf(() => decodeCaptureMeta(new Uint8Array([0x7b, 0xff, 0x7d])))).toBe("badUtf8");
    expect(codeOf(() => decodeCaptureMeta(enc('{"project":{},"device":{"preset":1,"sampleRate":48000},"names":{"clips":{"x":"a"}}}')))).toBe("badMeta");
  });
});

describe("splitCaptureRecords (ADR 0417)", () => {
  /** Records of payload sizes `sizes`, framed back to back; each payload's bytes are its index. */
  const stream = (sizes: number[]): Uint8Array => {
    const out = new Uint8Array(sizes.reduce((n, s) => n + 20 + s, 0));
    const view = new DataView(out.buffer);
    let off = 0;
    sizes.forEach((len, i) => {
      off += writeRecordHead(view, off, { type: 0x17, flags: 0, epoch: 0, len, seq: i, frame: 0 });
      out.fill(i, off, off + len);
      off += len;
    });
    return out;
  };

  it("cuts whole records off a stream cut at any byte, leaving the rest", () => {
    const bytes = stream([3, 0, 40]);
    for (let cut = 0; cut <= bytes.byteLength; cut++) {
      const seen: { seq: number; len: number; first: number }[] = [];
      const used = splitCaptureRecords(bytes.subarray(0, cut), (h, view, at) => seen.push({ seq: h.seq, len: h.len, first: h.len ? view.getUint8(at) : -1 }));
      const whole = [23, 43, 103].filter((end) => end <= cut);
      expect(used).toBe(whole.at(-1) ?? 0);
      expect(seen.map((s) => s.seq)).toEqual(whole.map((_, i) => i));
      if (seen[2]) expect(seen[2]).toEqual({ seq: 2, len: 40, first: 2 });
    }
  });

  it("refuses a record past its cap before waiting for its bytes", () => {
    const bytes = stream([1]);
    new DataView(bytes.buffer).setUint32(4, 1 << 24, true);
    expect(codeOf(() => splitCaptureRecords(bytes, () => {}))).toBe("recordTooLarge");
  });
});
