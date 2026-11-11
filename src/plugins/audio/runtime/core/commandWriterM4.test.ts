// ADR 0166 M4 (Z4, leaf L-Z4b; api-and-models §4.1, §4.2): the shape word, `fadeZero` and the gate on the writer. Cases
// read the posted BATCH back with the generated readers (`readPlay`, `readFade`, `readStop`, `readSetParams`) like
// `commandWriterM3.test.ts`. The group-batching case stays skipped: `flush`'s group keeping is the lead's.
import { describe, expect, it } from "vitest";
import {
  ASAP,
  FADE_FLAGS_STOP_AT_END,
  FadeLaw,
  Op,
  PLAY_FLAGS_AMBISONIC,
  PLAY_FLAGS_FADE_ZERO,
  PLAY_FLAGS_MIXED,
  SET_PARAMS_MASK_GAIN,
  gateGroupId,
  gateGroupSize,
  packGate,
  packShape,
  readBatchHeader,
  readEnvelope,
  readFade,
  readPlay,
  readRecordHead,
  readSetParams,
  readStop,
  shapeLaw,
  shapeStartPhase,
} from "../wire.generated";
import { createBatchPool, type BufferPool } from "./bufferPool";
import { CommandWriter, STAGING_BYTES, type BatchPort, type PlayArgs } from "./commandWriter";

function rig(sampleRate = 48_000) {
  const pool: BufferPool = createBatchPool();
  const posted: ArrayBuffer[] = [];
  let seq = 100;
  const port: BatchPort = {
    batchPool: pool,
    nextSeq: () => seq++,
    post: (b) => posted.push(b),
  };
  return { writer: new CommandWriter(port, sampleRate), pool, posted };
}

const play = (voiceId: number, flags = PLAY_FLAGS_MIXED): PlayArgs => ({ voiceId, clip: 7, bus: 1, flags, group: 0, gain: 0.5, pitch: 1, dirX: 0, dirY: 0, dirZ: -1, lpHz: 24000, score: 1, startOffsetFrames: 0 });

/** The records of one posted batch, in order. */
function records(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const env = readEnvelope(view, 0);
  const header = readBatchHeader(view, 0);
  const out: { op: number; voiceId: number; frameOffset: number; off: number; bytes: number }[] = [];
  let off = 32;
  for (let i = 0; i < header.count; i++) {
    const head = readRecordHead(view, off);
    out.push({ op: head.opcode, voiceId: head.voiceId, frameOffset: head.frameOffset, off, bytes: head.words * 4 });
    off += head.words * 4;
  }
  expect(off).toBe(16 + env.bodyBytes);
  return { env, header, records: out, view };
}

describe("CommandWriter, ADR 0166 records (L-Z4b)", () => {
  it("play writes gate 0 without PlayArgs.gate, and the given gate with it", () => {
    const { writer, posted } = rig();
    writer.play(play(1));
    writer.play({ ...play(2), gate: packGate(5, 3) });
    writer.flush(0);
    const b = records(posted[0]!);
    expect(b.records.map((r) => r.bytes)).toEqual([56, 56]);
    expect(readPlay(b.view, b.records[0]!.off).gate).toBe(0);
    const second = readPlay(b.view, b.records[1]!.off);
    expect(second.gate).toBe(packGate(5, 3));
    expect(gateGroupId(second.gate)).toBe(5);
    expect(gateGroupSize(second.gate)).toBe(3);
  });

  it("playGated packs packGate(groupId, groupSize) into the PLAY gate (id 1023, size 64 and id 1, size 1 round-trip through gateGroupId and gateGroupSize) and is stamped like play", () => {
    const { writer, posted } = rig();
    writer.playGated(play(1), 1023, 64, 3000);
    writer.playGated(play(2), 1, 1, 3000);
    writer.play(play(3), 1000);
    writer.flush(0);
    const b = records(posted[0]!);
    expect(b.records.map((r) => [r.op, r.voiceId, r.frameOffset])).toEqual([
      [Op.PLAY, 3, 0],
      [Op.PLAY, 1, 2000],
      [Op.PLAY, 2, 2000],
    ]);
    expect(b.header.firstFrame).toBe(1000);
    const big = readPlay(b.view, b.records[1]!.off).gate;
    expect(gateGroupId(big)).toBe(1023);
    expect(gateGroupSize(big)).toBe(64);
    const small = readPlay(b.view, b.records[2]!.off).gate;
    expect(gateGroupId(small)).toBe(1);
    expect(gateGroupSize(small)).toBe(1);
  });

  it("PlayArgs.fadeZero sets bit 8 (PLAY_FLAGS_FADE_ZERO) and keeps every other flag bit", () => {
    const { writer, posted } = rig();
    const flags = PLAY_FLAGS_MIXED | PLAY_FLAGS_AMBISONIC;
    writer.play({ ...play(1, flags), fadeZero: true });
    writer.play({ ...play(2, flags), fadeZero: false });
    writer.flush(0);
    const b = records(posted[0]!);
    expect(readPlay(b.view, b.records[0]!.off).flags).toBe(flags | PLAY_FLAGS_FADE_ZERO);
    expect(readPlay(b.view, b.records[1]!.off).flags).toBe(flags);
  });

  it("fade (asap, linear) is a 28-byte FADE whose shape word reads 0, so a plain fade keeps today's behaviour", () => {
    const { writer, posted } = rig();
    writer.fadeShaped(8, 0.25, 0.01, FadeLaw.EqualPowerOut, 0.5, 100);
    writer.fade(9, 0.5, 0.01);
    writer.flush(0);
    const b = records(posted[0]!);
    expect(b.records.map((r) => [r.op, r.voiceId, r.bytes])).toEqual([
      [Op.FADE, 9, 28],
      [Op.FADE, 8, 28],
    ]);
    const plain = readFade(b.view, b.records[0]!.off);
    expect(plain).toMatchObject({ voiceId: 9, frameOffset: ASAP, target: 0.5, frames: 480, flags: 0, shape: 0 });
  });

  it("fadeShaped writes a 28-byte FADE with packShape(law, startPhase) (law 2, phase 0.5 reads back as 2 and 32768), target, frames at the writer's rate and flags 0; stopAtEnd sets FADE_FLAGS_STOP_AT_END", () => {
    const { writer, posted } = rig();
    writer.fadeShaped(7, 0, 0.25, FadeLaw.EqualPowerIn, 0.5);
    writer.fadeShaped(8, 0.75, 0.25, FadeLaw.Linear, 0, undefined, true);
    writer.flush(0);
    const b = records(posted[0]!);
    expect(b.records.map((r) => r.bytes)).toEqual([28, 28]);
    const first = readFade(b.view, b.records[0]!.off);
    expect(first.shape).toBe(packShape(2, 32768));
    expect(shapeLaw(first.shape!)).toBe(2);
    expect(shapeStartPhase(first.shape!)).toBe(32768);
    expect(first).toMatchObject({ voiceId: 7, target: 0, frames: 12_000, flags: 0 });
    const second = readFade(b.view, b.records[1]!.off);
    expect(second).toMatchObject({ voiceId: 8, target: 0.75, frames: 12_000, flags: FADE_FLAGS_STOP_AT_END, shape: 0 });
  });

  it("fadeShaped with atFrame sorts among stamped records and gets a frameOffset at flush; without atFrame it is asap", () => {
    const { writer, posted } = rig();
    writer.fadeShaped(1, 1, 0.1, FadeLaw.SCurve, 0, 5000);
    writer.fadeShaped(2, 1, 0.1, FadeLaw.SCurve, 0);
    writer.fadeShaped(3, 1, 0.1, FadeLaw.SCurve, 0, 1000);
    writer.flush(0);
    const b = records(posted[0]!);
    expect(b.records.map((r) => [r.op, r.voiceId, r.frameOffset])).toEqual([
      [Op.FADE, 2, ASAP],
      [Op.FADE, 3, 0],
      [Op.FADE, 1, 4000],
    ]);
    expect(b.header.firstFrame).toBe(1000);
  });

  it("stopShaped writes a 24-byte STOP with the shape word and the fade in frames; stop (plain) is 24 bytes with shape 0", () => {
    const { writer, posted } = rig();
    writer.stopShaped(5, 0.02, FadeLaw.EqualPowerOut, 0.25);
    writer.stop(6, 0.02);
    writer.flush(0);
    const b = records(posted[0]!);
    expect(b.records.map((r) => [r.op, r.voiceId, r.bytes])).toEqual([
      [Op.STOP, 5, 24],
      [Op.STOP, 6, 24],
    ]);
    const shaped = readStop(b.view, b.records[0]!.off);
    expect(shaped.fadeFrames).toBe(960);
    expect(shapeLaw(shaped.shape!)).toBe(FadeLaw.EqualPowerOut);
    expect(shapeStartPhase(shaped.shape!)).toBe(16384);
    const plain = readStop(b.view, b.records[1]!.off);
    expect(plain.fadeFrames).toBe(960);
    expect(plain.shape).toBe(0);
  });

  it("setParams with shape writes a 60-byte SET_PARAMS carrying the shape word, stamped when atFrame is given; without them the shape reads 0", () => {
    const { writer, posted } = rig();
    writer.setParams(4, SET_PARAMS_MASK_GAIN, 0.5, 1, 0, 0, 0, 24000, 480, 0, packShape(FadeLaw.EqualPowerIn, 49152), 2000);
    writer.setParams(5, SET_PARAMS_MASK_GAIN, 0.25, 1, 0, 0, 0, 24000, 480);
    writer.setScore(6, 2);
    writer.flush(0);
    const b = records(posted[0]!);
    // The asap records (5, then 6 in send order) come before the stamped one.
    expect(b.records.map((r) => [r.op, r.voiceId, r.frameOffset, r.bytes])).toEqual([
      [Op.SET_PARAMS, 5, ASAP, 60],
      [Op.SET_PARAMS, 6, ASAP, 60],
      [Op.SET_PARAMS, 4, 0, 60],
    ]);
    const stamped = readSetParams(b.view, b.records[2]!.off);
    expect(shapeLaw(stamped.shape!)).toBe(FadeLaw.EqualPowerIn);
    expect(shapeStartPhase(stamped.shape!)).toBe(49152);
    expect(readSetParams(b.view, b.records[0]!.off).shape).toBe(0);
    expect(readSetParams(b.view, b.records[1]!.off).shape).toBe(0);
  });

  it.skip("a gate group's records stay in one BATCH: with records of group 7 straddling the 64 KB limit, the whole group moves to the next batch and its absolute frame is kept", () => {});

  it("staging capacity is checked at the new sizes (28, 60, 24 B), not the old (24, 56, 20): a full staging area drops a FADE that no longer fits", () => {
    const { writer } = rig();
    // 9360 FADEs of 28 B leave 64 B; a STOP (24 B) and a SET_PAUSED (16 B) leave exactly 24 B, too small for a 28-byte FADE.
    for (let i = 0; i < 9360; i++) writer.fade(i, 0, 0);
    writer.stop(1, 0);
    writer.setPaused(2, true);
    expect(writer.pending).toBe(9362);
    expect(writer.stats.dropped).toBe(0);
    writer.fadeShaped(3, 0, 0, FadeLaw.Linear, 0);
    expect(writer.pending).toBe(9362);
    expect(writer.stats.dropped).toBe(1);
    expect(writer.overflowed).toBe(true);
    // A 24-byte STOP still fits the last 24 bytes.
    writer.stopShaped(4, 0, FadeLaw.Linear, 0);
    expect(writer.pending).toBe(9363);
    expect(writer.stats.dropped).toBe(1);
    expect(STAGING_BYTES - 9360 * 28 - 24 - 16 - 24).toBe(0);
  });
});
