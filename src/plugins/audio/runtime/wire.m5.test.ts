// M5 wire, TypeScript side (task Wa1, leaf L-Wa1b): the BUS_RAMP, BUS_DUCK, BUS_PRESENCE, LOUD_CONFIG and BUS_SLOT
// vectors of `native/audio/crates/audio-wire/vectors/wire.json` round-trip through the generated codec, the M5
// constants and the ramp shape word match the spec (ADR 0171 section 4), and the STATUS M5 sections sit at their caps
// and at zero. The generated file and the vectors are owned by the schema generator and L-Wa1a, not by this file.
import { describe, expect, it } from "vitest";
import * as wire from "./wire.generated";
import { makeStatusBlock } from "./core/mirror";
import wireVectors from "../../../../native/audio/crates/audio-wire/vectors/wire.json";

interface Vector {
  name: string;
  subject: { type: string; name?: string };
  values: Record<string, unknown>;
  hex: string;
}

const VECTORS = wireVectors as unknown as Vector[];

/** A generated writer and reader; the record is passed as `never`, as in the M4 and round-trip files. */
interface Codec {
  read: (view: DataView, off: number) => unknown;
  write: (view: DataView, off: number, rec: never) => number;
}

/** The M5 opcodes this file covers, by their `Op` name. */
const M5_CODECS: Record<string, Codec> = {
  BUS_RAMP: { read: wire.readBusRamp, write: wire.writeBusRamp },
  BUS_DUCK: { read: wire.readBusDuck, write: wire.writeBusDuck },
  BUS_PRESENCE: { read: wire.readBusPresence, write: wire.writeBusPresence },
  LOUD_CONFIG: { read: wire.readLoudConfig, write: wire.writeLoudConfig },
  BUS_SLOT: { read: wire.readBusSlot, write: wire.writeBusSlot },
};

const M5_VECTOR_PREFIXES = ["BUS_RAMP_", "BUS_DUCK_", "BUS_PRESENCE_", "LOUD_CONFIG_", "BUS_SLOT_"];

function bytesOfHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function viewOfBytes(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A scratch message buffer, large enough for the worst-case STATUS (STATUS_WORST_CASE_BYTES). */
function scratch(): DataView {
  return new DataView(new ArrayBuffer(1 << 15));
}

/** The first `n` bytes of a scratch buffer, as hex. */
function writtenHex(view: DataView, n: number): string {
  return hexOf(new Uint8Array(view.buffer, 0, n).slice());
}

/** The value a call throws, or undefined when it returns. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectRefusal(fn: () => unknown, code: number, label: string): void {
  const err = thrownBy(fn);
  expect(err, label).toBeInstanceOf(wire.WireError);
  expect((err as wire.WireError).code, label).toBe(code);
}

function m5Vectors(): Vector[] {
  return VECTORS.filter((v) => v.subject.type === "Opcode" && M5_VECTOR_PREFIXES.some((p) => v.name.startsWith(p)));
}

/** A STATUS with every section at its cap (9 loudBuses, 288 loudEnergies, 32 busDuck, plus the M4 sections at theirs). */
function worstCaseStatus(): wire.StatusBlock {
  return makeStatusBlock({
    musicRingsOpen: 16,
    ended: Array.from({ length: 1024 }, (_, i) => i),
    demoted: Array.from({ length: 1024 }, (_, i) => i + 1),
    starved: Array.from({ length: 1024 }, (_, i) => i + 2),
    playheads: Array.from({ length: 256 }, (_, i) => ({ id: i, clipFrame: i * 480 })),
    clipEvents: Array.from({ length: 64 }, (_, i) => ({ clipId: i, code: 1 + (i % 5) })),
    streamEvents: Array.from({ length: 64 }, (_, i) => ({ id: i, code: 1 + (i % 4) })),
    peaks: Array.from({ length: 32 }, (_, i) => ({ l: i / 64, r: 0.5 })),
    beds: Array.from({ length: 4 }, (_, i) => ({ bus: i, voices: 8 * i, work: 100 * i })),
    zones: Array.from({ length: 4 }, (_, i) => ({ kernelId: 0xffff0200 + i, state: i, pad: 0, quantaSinceInput: i, wetPeak: 0.25 })),
    zoneEvents: Array.from({ length: 16 }, (_, i) => ({ slot: i % 4, code: 1 + (i % 3), reserved: 0 })),
    musicRings: Array.from({ length: 16 }, (_, i) => ({
      streamId: i + 1,
      epochFlags: (i | wire.MUSIC_RING_PRIMED | (i % 2 === 0 ? wire.MUSIC_RING_BOUND : 0)) >>> 0,
    })),
    groupStarts: Array.from({ length: 8 }, (_, i) => ({
      groupId: i + 1,
      flags: i % 8,
      slipFrames: 96 * i,
      startFrameLo: (0x80000000 + i) >>> 0,
      startFrameHi: i,
    })),
    loudBuses: Array.from({ length: wire.LOUD_METERS }, (_, i) => ({
      slot: i === wire.LOUD_METERS - 1 ? wire.LOUD_OUTPUT_TAP : i,
      flags: i,
      firstSeq: 1000 + i,
      truePeak: i / 8,
      gatedQuanta: i * 7,
    })),
    loudEnergies: Array.from({ length: wire.MAX_LOUD_ENERGIES }, (_, i) => i / 1024),
    busDuck: Array.from({ length: wire.MAX_DUCK_RULES }, (_, i) => ({ slot: i, pad: 0, gain: 1 - i / 64 })),
  });
}

/** The worst-case STATUS as written: its bytes, envelope included. */
function worstCaseBytes(): Uint8Array {
  const out = scratch();
  const n = wire.writeStatus(out, 0, worstCaseStatus(), 7);
  return new Uint8Array(out.buffer, 0, n).slice();
}

/** A copy of `bytes` with the u16 at `off` replaced. */
function withU16(bytes: Uint8Array, off: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint16(off, value, true);
  return copy;
}

describe("M5 wire vectors (L-Wa1b)", () => {
  it("every BUS_RAMP, BUS_DUCK, BUS_PRESENCE, LOUD_CONFIG and BUS_SLOT vector reads back to its values and writes back to its hex", () => {
    const vectors = m5Vectors();
    // A deleted vector fails here: the wire.json set holds at least these 11 M5 records.
    expect(vectors.length).toBeGreaterThanOrEqual(11);

    for (const v of vectors) {
      const codec = M5_CODECS[v.subject.name ?? ""];
      expect(codec, v.name).toBeDefined();
      const rec = codec.read(viewOfBytes(bytesOfHex(v.hex)), 0) as Record<string, unknown>;
      expect(rec, v.name).toEqual(v.values);
      const out = scratch();
      expect(writtenHex(out, codec.write(out, 0, rec as never)), v.name).toBe(v.hex);
    }
  });
});

describe("M5 ramp shape word and constants (L-Wa1b)", () => {
  it("BUS_RAMP shape: law in bits 0-2, sequence id in bits 3-15 (13 bits), start phase in bits 16-31", () => {
    expect(wire.packRampShape(0, 5, 0)).toBe(0x28);
    expect(wire.rampSequenceId(0xfff8)).toBe(8191);
    // The field is 13 bits: sequence 8192 wraps to 0 (none).
    expect(wire.packRampShape(0, 8192, 0)).toBe(0);
    expect(wire.rampSequenceId(wire.packRampShape(0, 8192, 0))).toBe(0);

    // A sequence id leaves the law and the start phase unchanged.
    const withSeq = wire.packRampShape(wire.FadeLaw.EqualPowerIn, 8191, 0x4000);
    const noSeq = wire.packRampShape(wire.FadeLaw.EqualPowerIn, 0, 0x4000);
    expect(wire.rampSequenceId(withSeq)).toBe(8191);
    expect(wire.shapeLaw(withSeq)).toBe(wire.shapeLaw(noSeq));
    expect(wire.shapeLaw(withSeq)).toBe(wire.FadeLaw.EqualPowerIn);
    expect(wire.shapeStartPhase(withSeq)).toBe(wire.shapeStartPhase(noSeq));
    expect(wire.shapeStartPhase(withSeq)).toBe(0x4000);
  });

  it("M5 opcodes, lanes and caps have their ADR 0171 values", () => {
    expect([wire.Op.BUS_RAMP, wire.Op.BUS_DUCK, wire.Op.BUS_PRESENCE, wire.Op.LOUD_CONFIG, wire.Op.BUS_SLOT]).toEqual([
      0x18, 0x19, 0x1a, 0x1b, 0x1c,
    ]);
    expect([wire.LANE_AUTHORED, wire.LANE_RUNTIME, wire.LANE_SNAPSHOT, wire.LANE_MONITOR, wire.LANE_DIP, wire.LANE_DUCK, wire.LANE_AUTOMATION]).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    expect(wire.MAX_LOUDNESS_BUSES).toBe(8);
    expect(wire.LOUD_METERS).toBe(9);
    expect(wire.LOUD_RING_SUBBLOCKS).toBe(32);
    expect(wire.LOUD_OUTPUT_TAP).toBe(0xffff);
    expect(wire.BUS_MASTER_OUT).toBe(0xffff);
    expect(wire.MAX_DUCK_RULES).toBe(32);
    expect(wire.MAX_LEVEL_RULES).toBe(8);
    expect(wire.BUS_MIN_RAMP_MS).toBe(5);
    expect(wire.DRAG_RAMP_MS).toBe(10);
    expect(wire.FADER_COALESCE_MS).toBe(4);
    expect(wire.TOMBSTONE_TAIL_FRAMES).toBe(128);
    expect(wire.COMPRESSOR_SMOOTH_MS).toBe(20);
    expect(wire.STATUS_HEADER_BYTES).toBe(256);
    expect(wire.STATUS_BUFFER_BYTES).toBe(20480);
    expect(wire.STATUS_WORST_CASE_BYTES).toBe(17824);
    expect(wire.VERSION_MINOR).toBe(3);
  });
});

describe("M5 STATUS sections at the caps and at zero (L-Wa1b)", () => {
  it("every section at its cap writes 17,824 B into a STATUS_BUFFER_BYTES buffer and reads back equal; the M5 header fields sit at API 4.3's offsets", () => {
    const block: wire.StatusBlock = {
      ...worstCaseStatus(),
      busyMsTotal: 1234.5,
      quantaTotal: 77.25,
      wuVoices: 1.5,
      wuBuses: 2.5,
      wuSpatial: 3.5,
      wuMusic: 4.5,
      wuLoudness: 5.5,
      clockStepMs: 0x1234,
      loudSubBlockFrames: 0x01020304,
      clockSteps: 0x0abc,
      loudShed: 7,
      busRecordsEarly: 8,
      sidechainLate: 9,
      reserved2: 0xdeadbeef,
    };
    const buffer = new ArrayBuffer(wire.STATUS_BUFFER_BYTES);
    const n = wire.writeStatus(new DataView(buffer), 0, block, 3);
    expect(n).toBe(wire.STATUS_WORST_CASE_BYTES);
    expect(n).toBeLessThanOrEqual(wire.STATUS_BUFFER_BYTES);

    const bytes = new Uint8Array(buffer, 0, n).slice();
    expect(wire.readStatus(bytes)).toEqual(block);

    const dv = new DataView(bytes.buffer);
    expect(dv.getFloat64(176, true)).toBe(1234.5);
    expect(dv.getFloat64(184, true)).toBe(77.25);
    expect([192, 200, 208, 216, 224].map((off) => dv.getFloat64(off, true))).toEqual([1.5, 2.5, 3.5, 4.5, 5.5]);
    expect(dv.getUint16(232, true)).toBe(wire.LOUD_METERS);
    expect(dv.getUint16(234, true)).toBe(wire.MAX_LOUD_ENERGIES);
    expect(dv.getUint16(236, true)).toBe(wire.MAX_DUCK_RULES);
    expect(dv.getUint16(238, true)).toBe(0x1234);
    expect(dv.getUint32(240, true)).toBe(0x01020304);
    expect(dv.getUint16(244, true)).toBe(0x0abc);
    expect(dv.getUint16(246, true)).toBe(7);
    expect(dv.getUint16(248, true)).toBe(8);
    expect(dv.getUint16(250, true)).toBe(9);
    // The last header word (252) is the StatusBlock's `reserved2`.
    expect(dv.getUint32(252, true)).toBe(0xdeadbeef);
  });

  it("an all-default STATUS writes exactly the 256 B header, its M5 bytes 176..255 are zero, and the three M5 arrays read empty", () => {
    const buffer = new ArrayBuffer(wire.STATUS_BUFFER_BYTES);
    const n = wire.writeStatus(new DataView(buffer), 0, makeStatusBlock(), 1);
    expect(n).toBe(wire.STATUS_HEADER_BYTES);

    const bytes = new Uint8Array(buffer, 0, n).slice();
    expect(Array.from(bytes.subarray(176, 256)).every((b) => b === 0)).toBe(true);

    const back = wire.readStatus(bytes);
    expect(back.loudBuses).toEqual([]);
    expect(back.loudEnergies).toEqual([]);
    expect(back.busDuck).toEqual([]);
  });

  it("a header count one over a cap is refused with OVERSIZE, by the reader; one item over a cap is refused by the writer", () => {
    const bytes = worstCaseBytes();
    expectRefusal(() => wire.readStatus(withU16(bytes, 232, 10)), wire.ErrorCode.OVERSIZE, "reader: 10 loudBuses");
    expectRefusal(() => wire.readStatus(withU16(bytes, 234, 289)), wire.ErrorCode.OVERSIZE, "reader: 289 loudEnergies");
    expectRefusal(() => wire.readStatus(withU16(bytes, 236, 33)), wire.ErrorCode.OVERSIZE, "reader: 33 busDuck");

    const worst = worstCaseStatus();
    const over = (fields: Partial<wire.StatusBlock>) => () => wire.writeStatus(scratch(), 0, { ...worst, ...fields }, 1);
    expectRefusal(
      over({ loudBuses: [...worst.loudBuses, worst.loudBuses[0]] }),
      wire.ErrorCode.OVERSIZE,
      "writer: 10 loudBuses",
    );
    expectRefusal(over({ loudEnergies: [...worst.loudEnergies, 0] }), wire.ErrorCode.OVERSIZE, "writer: 289 loudEnergies");
    expectRefusal(over({ busDuck: [...worst.busDuck, worst.busDuck[0]] }), wire.ErrorCode.OVERSIZE, "writer: 33 busDuck");
  });

  it("every truncation of a STATUS with all three M5 sections non-empty throws a WireError, never a RangeError", () => {
    const bytes = worstCaseBytes();
    for (let len = 0; len < bytes.length; len++) {
      expect(thrownBy(() => wire.readStatus(bytes.subarray(0, len))), `truncated to ${len} bytes`).toBeInstanceOf(wire.WireError);
    }
  });

  it("a STATUS cut to 176 bytes with bodyBytes 160 is refused as TRUNCATED: the header alone is 256 B", () => {
    const cut = worstCaseBytes().slice(0, 176);
    // bodyBytes is the u32 at offset 12 of the envelope.
    new DataView(cut.buffer).setUint32(12, 160, true);
    expectRefusal(() => wire.readStatus(cut), wire.ErrorCode.TRUNCATED, "176-byte STATUS with bodyBytes 160");
  });
});
