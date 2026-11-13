// M4 wire, TypeScript side (task W1; leaf L-W1b fills the skipped cases): the shape word, PLAY `gate` and
// `fadeZero`, STREAM_OPEN `music`, the `musicRings` and `groupStarts` STATUS sections, read against the
// vectors in `native/audio/crates/audio-wire/vectors/wire.json` (which L-Z1a, L-W1a and the generator own).
// The first two cases are live and pin the packers and the older-record rule.
import { describe, expect, it } from "vitest";
import * as wire from "./wire.generated";
import { makeStatusBlock } from "./core/mirror";
import wireVectors from "../../../../native/audio/crates/audio-wire/vectors/wire.json";

describe("M4 wire packers", () => {
  it("shape word and gate packers", () => {
    const shape = wire.packShape(wire.FadeLaw.EqualPowerIn, 0x4000);
    expect(wire.shapeLaw(shape)).toBe(wire.FadeLaw.EqualPowerIn);
    expect(wire.shapeStartPhase(shape)).toBe(0x4000);
    expect(wire.packGate(1023, 64)).toBe(0xffff);
    expect([wire.gateGroupId(0xffff), wire.gateGroupSize(0xffff)]).toEqual([1023, 64]);
    expect(wire.packGate(0, 5)).toBe(0);
  });

  it("an older FADE without the shape word reads shape 0; the writer always writes 28 B", () => {
    const view = new DataView(new ArrayBuffer(64));
    expect(wire.writeFade(view, 0, { voiceId: 1, frameOffset: 2, target: 1, frames: 3, flags: 0 })).toBe(28);
    view.setUint16(2, 6, true);
    expect(wire.readFade(new DataView(view.buffer, 0, 24), 0).shape).toBe(0);
  });
});

interface Vector {
  name: string;
  subject: { type: string; name?: string };
  values: Record<string, unknown>;
  hex: string;
}

const VECTORS = wireVectors as unknown as Vector[];

/** A generated writer and reader; the record is passed as `never`, as in the round-trip file. */
interface Codec {
  write: (view: DataView, off: number, rec: never) => number;
  read: (view: DataView, off: number) => unknown;
}

/** The per-voice opcodes of the gate family: PLAY (gate, fadeZero), FADE, STOP and SET_PARAMS (the shape word). */
const GATE_FAMILY: Record<string, Codec> = {
  PLAY: { write: wire.writePlay, read: wire.readPlay },
  STOP: { write: wire.writeStop, read: wire.readStop },
  SET_PARAMS: { write: wire.writeSetParams, read: wire.readSetParams },
  FADE: { write: wire.writeFade, read: wire.readFade },
};

function vectorNamed(name: string): Vector {
  const found = VECTORS.find((v) => v.name === name);
  if (found === undefined) throw new Error(`no vector ${name}`);
  return found;
}

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

function inGateFamily(v: Vector): boolean {
  if (v.subject.type === "Opcode") return Object.prototype.hasOwnProperty.call(GATE_FAMILY, v.subject.name ?? "");
  if (v.subject.type === "Kind") return v.subject.name === "STREAM_OPEN";
  return v.subject.type === "Status";
}

/** A STATUS with every section at its cap, including 16 musicRings and 8 groupStarts; it encodes to STATUS_WORST_CASE_BYTES. */
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
    // ADR 0171 M5 sections at their caps: 9 meters (the output tap last), 288 energies, 32 duck targets.
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

describe("M4 wire vectors (L-W1b)", () => {
  /** Every record of `wire.json` for the longer per-voice records, a gated PLAY, STREAM_OPEN with `music`, and the music STATUS sections reads back to its `values` and writes back to its `hex`. */
  it("L-W1b: the gate-family vectors round trip (read, then write, equals hex)", () => {
    const seen: string[] = [];
    for (const v of VECTORS.filter(inGateFamily)) {
      seen.push(v.name);
      const view = viewOfBytes(bytesOfHex(v.hex));
      const expected: Record<string, unknown> = { ...v.values };
      delete expected.seq;
      const out = scratch();

      if (v.subject.type === "Opcode") {
        const name = v.subject.name ?? "";
        const codec = GATE_FAMILY[name];
        const rec = codec.read(view, 0) as Record<string, unknown>;
        expect(rec, v.name).toMatchObject(expected);
        if (name !== "PLAY") {
          // The shape word: law (bits 0-2) and startPhase (bits 16-31) pack back to the same word.
          const shape = rec.shape as number;
          expect(wire.packShape(wire.shapeLaw(shape), wire.shapeStartPhase(shape)), v.name).toBe(shape);
        }
        expect(writtenHex(out, codec.write(out, 0, rec as never)), v.name).toBe(v.hex);
      } else if (v.subject.type === "Kind") {
        expect(wire.readEnvelope(view, 0).kind, v.name).toBe(wire.Kind.STREAM_OPEN);
        const rec = wire.readStreamOpen(view, 0);
        expect(rec, v.name).toMatchObject(expected);
        const n = wire.writeStreamOpen(out, 0, rec);
        wire.writeEnvelope(out, 0, { kind: wire.Kind.STREAM_OPEN, seq: v.values.seq as number, bodyBytes: n - wire.ENVELOPE_BYTES });
        expect(writtenHex(out, n), v.name).toBe(v.hex);
      } else {
        const rec = wire.readStatus(bytesOfHex(v.hex));
        expect(rec, v.name).toMatchObject(expected);
        const n = wire.writeStatus(out, 0, rec, wire.readEnvelope(view, 0).seq);
        expect(writtenHex(out, n), v.name).toBe(v.hex);
      }
    }
    expect(seen).toEqual(
      expect.arrayContaining([
        "FADE_stop_at_end",
        "FADE_equal_power_in_phase_quarter",
        "STOP_fade_asap",
        "STOP_equal_power_out",
        "SET_PARAMS_panner_change",
        "SET_PARAMS_s_curve",
        "PLAY_fade_zero",
        "PLAY_loop_hrtf_spatial",
        "STREAM_OPEN_loop",
        "STREAM_OPEN_16ch_fuma",
        "STATUS_m4_header_only",
        "STATUS_adr0162_sections",
      ]),
    );

    // PLAY fadeZero is flags bit 8 (PLAY_FLAGS_FADE_ZERO) on the fade-zero vector.
    const fadeZero = wire.readPlay(viewOfBytes(bytesOfHex(vectorNamed("PLAY_fade_zero").hex)), 0);
    expect(fadeZero.flags & wire.PLAY_FLAGS_FADE_ZERO).toBe(wire.PLAY_FLAGS_FADE_ZERO);

    // No vector sets the music bit of STREAM_OPEN flags, so it is checked on a copy of the loop vector.
    const open = wire.readStreamOpen(viewOfBytes(bytesOfHex(vectorNamed("STREAM_OPEN_loop").hex)), 0);
    const music = scratch();
    wire.writeStreamOpen(music, 0, { ...open, flags: open.flags | wire.STREAM_OPEN_FLAG_MUSIC });
    expect(wire.readStreamOpen(music, 0).flags).toBe(open.flags | wire.STREAM_OPEN_FLAG_MUSIC);
  });

  /** A STATUS with every section at its cap (16 musicRings, 8 groupStarts, the M5 loudness and duck sections) is STATUS_WORST_CASE_BYTES (17,824) and `readStatus` returns every item; a header count above its cap throws WireError OVERSIZE. */
  it("L-W1b: the STATUS music sections at their caps", () => {
    const worst = worstCaseStatus();
    const out = scratch();
    const n = wire.writeStatus(out, 0, worst, 42);
    expect(wire.STATUS_WORST_CASE_BYTES).toBe(17824);
    expect(n).toBe(wire.STATUS_WORST_CASE_BYTES);

    const bytes = new Uint8Array(out.buffer, 0, n).slice();
    const back = wire.readStatus(bytes);
    expect(back.musicRings).toHaveLength(16);
    expect(back.groupStarts).toHaveLength(8);
    expect(back).toEqual(worst);
    expect(wire.readEnvelope(viewOfBytes(bytes), 0).seq).toBe(42);

    // A header count one above a cap is refused with OVERSIZE, by the reader and by the writer.
    const musicOver = bytes.slice();
    new DataView(musicOver.buffer).setUint16(144, 17, true);
    expectRefusal(() => wire.readStatus(musicOver), wire.ErrorCode.OVERSIZE, "reader: 17 musicRings");
    const groupsOver = bytes.slice();
    new DataView(groupsOver.buffer).setUint16(146, 9, true);
    expectRefusal(() => wire.readStatus(groupsOver), wire.ErrorCode.OVERSIZE, "reader: 9 groupStarts");
    expectRefusal(
      () => wire.writeStatus(scratch(), 0, { ...worst, musicRings: [...worst.musicRings, { streamId: 17, epochFlags: 0 }] }, 1),
      wire.ErrorCode.OVERSIZE,
      "writer: 17 musicRings",
    );
    expectRefusal(
      () => wire.writeStatus(scratch(), 0, { ...worst, groupStarts: [...worst.groupStarts, worst.groupStarts[0]] }, 1),
      wire.ErrorCode.OVERSIZE,
      "writer: 9 groupStarts",
    );
  });

  /** Every truncation of a STATUS carrying both sections throws a WireError (never a RangeError); PLAY with gate 0xffff reads group 1023 and size 64. */
  it("L-W1b: truncation fuzz and the corner gate", () => {
    const out = scratch();
    const n = wire.writeStatus(out, 0, worstCaseStatus(), 5);
    const bytes = new Uint8Array(out.buffer, 0, n).slice();
    for (let len = 0; len < n; len++) {
      expect(thrownBy(() => wire.readStatus(bytes.subarray(0, len))), `truncated to ${len} bytes`).toBeInstanceOf(wire.WireError);
    }

    // The corner gate: group 1023 at size 64 packs to 0xffff (the gate field is at offset 22 of a PLAY record).
    expect(wire.packGate(1023, 64)).toBe(0xffff);
    const play = scratch();
    const rec = { ...wire.readPlay(viewOfBytes(bytesOfHex(vectorNamed("PLAY_fade_zero").hex)), 0), gate: 0xffff };
    wire.writePlay(play, 0, rec);
    expect(play.getUint16(22, true)).toBe(0xffff);
    const back = wire.readPlay(play, 0);
    expect(back.gate).toBe(0xffff);
    expect([wire.gateGroupId(back.gate), wire.gateGroupSize(back.gate)]).toEqual([1023, 64]);
  });
});
