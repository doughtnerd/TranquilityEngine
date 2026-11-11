// ADR 0162 (A1, leaf L-A1c): the command writer's M3 records (api-and-models §4.2, contracts C1-C5): SET_VOICE_FX,
// BED_CONFIG, ZONE_CONFIG, LISTENER and PLAY bit 7. Skeleton by the A1 lead: every case is skipped with its intent;
// L-A1c fills the methods in commandWriter.ts and un-skips these.
import { describe, expect, it } from "vitest";
import {
  ASAP,
  LISTENER_FLAGS_SNAP,
  MAX_BEDS,
  MAX_ZONE_SLOTS,
  Op,
  PANNER_BED,
  PLAY_FLAGS_AMBISONIC,
  PLAY_FLAGS_MIXED,
  PLAY_FLAGS_PANNER_SHIFT,
  SET_VOICE_FX_MASK_AUX,
  SET_VOICE_FX_MASK_HP_HZ,
  SET_VOICE_FX_MASK_SENDS,
  SET_VOICE_FX_MASK_YAW,
  readBatchHeader,
  readBedConfig,
  readEnvelope,
  readListener,
  readPlay,
  readRecordHead,
  readSetVoiceFx,
  readZoneConfig,
  type SetVoiceFx,
} from "../wire.generated";
import { createBatchPool, type BufferPool } from "./bufferPool";
import { CommandWriter, STAGING_BYTES, type BatchPort, type PlayArgs, type VoiceFxArgs } from "./commandWriter";

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

const fx = (voiceId: number, over: Partial<VoiceFxArgs> = {}): VoiceFxArgs => ({
  voiceId,
  mask: SET_VOICE_FX_MASK_HP_HZ | SET_VOICE_FX_MASK_SENDS | SET_VOICE_FX_MASK_YAW | SET_VOICE_FX_MASK_AUX,
  rampFrames: 480,
  hpHz: 120,
  send: [0.5, 0.25, 0.125, 1],
  yaw: 1.5,
  auxLevel: 0.25,
  auxBus: 3,
  ...over,
});

/**
 * Drains the writer and returns the opcodes and batch flags of everything posted. Each batch is read right after its
 * flush and then released: the pool hands the same buffers out again, so a posted buffer is only valid until then.
 */
function drain(writer: CommandWriter, pool: BufferPool, posted: ArrayBuffer[]) {
  const ops: number[] = [];
  const flags: number[] = [];
  let released = 0;
  while (writer.pending > 0) {
    writer.flush(0);
    for (; released < posted.length; released++) {
      const b = records(posted[released]!);
      ops.push(...b.records.map((r) => r.op));
      flags.push(b.header.flags);
      pool.release(posted[released]!);
    }
  }
  return { ops, flags };
}

describe("CommandWriter, ADR 0162 records", () => {
  it("setVoiceFx writes a 52-byte SET_VOICE_FX that readSetVoiceFx reads back field for field (mask, ramp, hpHz, four sends, yaw, aux)", () => {
    const { writer, posted } = rig();
    writer.setVoiceFx(fx(9));
    writer.flush(0);
    const b = records(posted[0]!);
    expect(b.records.map((r) => r.op)).toEqual([Op.SET_VOICE_FX]);
    expect(b.records[0]!.bytes).toBe(52);
    const r: SetVoiceFx = readSetVoiceFx(b.view, b.records[0]!.off);
    expect(r).toMatchObject({
      voiceId: 9,
      frameOffset: ASAP,
      mask: SET_VOICE_FX_MASK_HP_HZ | SET_VOICE_FX_MASK_SENDS | SET_VOICE_FX_MASK_YAW | SET_VOICE_FX_MASK_AUX,
      rampFrames: 480,
      hpHz: 120,
      send: [0.5, 0.25, 0.125, 1],
      yaw: 1.5,
      auxLevel: 0.25,
      auxBus: 3,
      reserved: 0,
    });
  });

  it("setVoiceFx is stamped like PLAY: with atFrame it sorts and gets a frameOffset; without, it is asap", () => {
    const { writer, posted } = rig();
    writer.play(play(3), 2_000);
    writer.setVoiceFx(fx(3), 2_000);
    writer.setVoiceFx(fx(4, { hpHz: 0 }));
    writer.flush(1_000);
    const b = records(posted[0]!);
    expect(b.records.map((r) => [r.op, r.voiceId, r.frameOffset])).toEqual([
      [Op.SET_VOICE_FX, 4, ASAP],
      [Op.PLAY, 3, 0],
      [Op.SET_VOICE_FX, 3, 0],
    ]);
    expect(b.header.firstFrame).toBe(2_000);
  });

  it("setVoiceFx copies the sends without keeping the caller's array (a later edit to it changes nothing posted)", () => {
    const { writer, posted } = rig();
    const send = [0.5, 0.25, 0.125, 1];
    writer.setVoiceFx(fx(9, { send }));
    send[0] = 9;
    send[3] = 9;
    writer.flush(0);
    const b = records(posted[0]!);
    expect(readSetVoiceFx(b.view, b.records[0]!.off).send).toEqual([0.5, 0.25, 0.125, 1]);
  });

  it("bedConfig writes 20 + pad4(buses) + pad4(2 x slots) bytes (5 buses, 3 slots: 36 B) with zero padding, read back by readBedConfig", () => {
    const { writer, posted } = rig();
    writer.bedConfig([0, 1, 0xff, 2, 0xff], [4, 0xffff, 5]);
    writer.flush(0);
    const b = records(posted[0]!);
    expect(b.records.map((r) => r.op)).toEqual([Op.BED_CONFIG]);
    expect(b.records[0]!.bytes).toBe(36);
    const off = b.records[0]!.off;
    expect(readBedConfig(b.view, off)).toMatchObject({ voiceId: 0, frameOffset: ASAP, bedSlot: [0, 1, 0xff, 2, 0xff], hostBus: [4, 0xffff, 5] });
    // Padding: bed slots occupy 20..24 (pad 25..27), host buses 28..33 (pad 34..35).
    for (const i of [25, 26, 27, 34, 35]) expect(b.view.getUint8(off + i)).toBe(0);
  });

  it("bedConfig with more than MAX_BEDS slots writes nothing, counts a drop and flags the next batch overflowed", () => {
    const { writer, posted } = rig();
    writer.bedConfig([0, 0xff], Array.from({ length: MAX_BEDS + 1 }, () => 0xffff));
    expect(writer.stats.dropped).toBe(1);
    expect(writer.pending).toBe(0);
    writer.listener(0, 0, 0, 1, 0, false);
    writer.flush(0);
    const b = records(posted[0]!);
    expect(b.records.map((r) => r.op)).toEqual([Op.LISTENER]);
    expect(b.header.flags & 1).toBe(1);
  });

  it("zoneConfig writes 24 + 16n bytes (n = 0, 3, 4) read back by readZoneConfig; more than MAX_ZONE_SLOTS slots is dropped and flagged", () => {
    const slot = (k: number) => ({ kernelId: 100 + k, returnBus: k, state: 1, reserved: 0, wet: 0.5, irFrames: 4096 + k });
    for (const n of [0, 3, 4]) {
      const { writer, posted } = rig();
      const slots = Array.from({ length: n }, (_, k) => slot(k));
      writer.zoneConfig(0.75, 960, slots);
      writer.flush(0);
      const b = records(posted[0]!);
      expect(b.records.map((r) => r.op)).toEqual([Op.ZONE_CONFIG]);
      expect(b.records[0]!.bytes).toBe(24 + 16 * n);
      expect(readZoneConfig(b.view, b.records[0]!.off)).toMatchObject({ sharedReturnGain: 0.75, rampFrames: 960, slots });
    }
    const { writer, posted } = rig();
    writer.zoneConfig(1, 0, Array.from({ length: MAX_ZONE_SLOTS + 1 }, (_, k) => slot(k)));
    expect(writer.stats.dropped).toBe(1);
    expect(writer.pending).toBe(0);
    writer.flush(0);
    expect(posted).toHaveLength(0);
    writer.listener(0, 0, 0, 1, 0, false);
    writer.flush(0);
    expect(readBatchHeader(new DataView(posted[0]!), 0).flags & 1).toBe(1);
  });

  it("listener writes a 36-byte LISTENER, asap, with flags bit0 set only for snap", () => {
    const { writer, posted } = rig();
    writer.listener(0.5, -0.5, 0.25, 0.75, 240, true);
    writer.listener(0, 0, 0, 1, 0, false);
    writer.flush(0);
    const b = records(posted[0]!);
    expect(b.records.map((r) => [r.op, r.frameOffset, r.bytes])).toEqual([
      [Op.LISTENER, ASAP, 36],
      [Op.LISTENER, ASAP, 36],
    ]);
    expect(readListener(b.view, b.records[0]!.off)).toEqual({ voiceId: 0, frameOffset: ASAP, qx: 0.5, qy: -0.5, qz: 0.25, qw: 0.75, rampFrames: 240, flags: LISTENER_FLAGS_SNAP });
    expect(readListener(b.view, b.records[1]!.off).flags).toBe(0);
  });

  it("PLAY with PLAY_FLAGS_AMBISONIC (bit 7) and panner PANNER_BED keeps both bits on the wire", () => {
    const { writer, posted } = rig();
    const flags = PLAY_FLAGS_MIXED | PLAY_FLAGS_AMBISONIC | (PANNER_BED << PLAY_FLAGS_PANNER_SHIFT);
    writer.play(play(6, flags));
    writer.flush(0);
    const b = records(posted[0]!);
    const p = readPlay(b.view, b.records[0]!.off);
    expect(p.flags).toBe(flags);
    expect(p.flags & PLAY_FLAGS_AMBISONIC).toBe(PLAY_FLAGS_AMBISONIC);
    expect((p.flags >> PLAY_FLAGS_PANNER_SHIFT) & 3).toBe(PANNER_BED);
  });

  it("the M3 records go out in a BATCH beside M1/M2 records in staging order, and a full staging area drops them like any other record", () => {
    const { writer, posted } = rig();
    writer.reset(false);
    writer.play(play(1), 500);
    writer.setVoiceFx(fx(1), 500);
    writer.listener(0, 0, 0, 1, 0, false);
    writer.flush(0);
    const b = records(posted[0]!);
    // Asap records first (stable), then the stamped PLAY and SET_VOICE_FX.
    expect(b.records.map((r) => r.op)).toEqual([Op.RESET, Op.LISTENER, Op.PLAY, Op.SET_VOICE_FX]);
    expect(b.header.count).toBe(4);

    // Fill the staging area with PLAYs (56 B each); the M3 records then have no room and are dropped.
    const { writer: full, posted: fullPosted, pool: fullPool } = rig();
    const fit = Math.floor(STAGING_BYTES / 56);
    for (let i = 0; i < fit; i++) full.play(play(i + 1));
    const before = full.stats.dropped;
    full.setVoiceFx(fx(1));
    full.bedConfig([0], [1]);
    full.zoneConfig(1, 0, []);
    full.listener(0, 0, 0, 1, 0, false);
    expect(full.stats.dropped - before).toBe(4);
    const { ops, flags } = drain(full, fullPool, fullPosted);
    expect(ops).toHaveLength(fit);
    expect(ops.every((op) => op === Op.PLAY)).toBe(true);
    expect(flags.some((f) => (f & 1) === 1)).toBe(true);
  });
});
