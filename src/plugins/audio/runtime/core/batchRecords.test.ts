// The command stream's records, walked (`batchRecords.ts`): a BATCH the command writer posts and a REPLAY the replay
// builder posts list every record with its opcode, voice, absolute frame (-1 asap) and offset, so the generated reader of
// its opcode decodes it; anything else on the link is not a batch.
import { describe, expect, it } from "vitest";
import { ASAP, BUS_LP_OFF_HZ, BUS_RAMP_MASK_GAIN, Kind, LANE_AUTHORED, Op, STATUS_BUFFER_BYTES, readBusRamp, readBusSlot, readReset, writeReset, writeStatus } from "../wire.generated";
import { batchRecords } from "./batchRecords";
import { CommandWriter } from "./commandWriter";
import { makeStatusBlock } from "./mirror";
import { ReplayBuilder } from "./replay";

/** A link that keeps what is posted. */
function recordingLink() {
  const posted: ArrayBuffer[] = [];
  return { posted, batchPool: { acquire: () => new ArrayBuffer(64 * 1024), release: () => true }, nextSeq: () => 1, post: (b: ArrayBuffer) => void posted.push(b) };
}

describe("batchRecords", () => {
  it("lists a BATCH's records in order: opcode, voice, absolute frame (asap -1) and the offset its reader takes", () => {
    const link = recordingLink();
    const w = new CommandWriter(link as never, 48_000);
    w.busRampFrames(3, LANE_AUTHORED, BUS_RAMP_MASK_GAIN, 0.5, BUS_LP_OFF_HZ, 480);
    w.busSlot({ slot: 2, parent: 0, effects: [] }, 9_600);
    w.busRampFrames(1, LANE_AUTHORED, BUS_RAMP_MASK_GAIN, 0.25, BUS_LP_OFF_HZ, 96, 0, 12_800);
    w.flush(9_000);
    expect(link.posted).toHaveLength(1);
    const batch = batchRecords(link.posted[0]!)!;
    expect(batch.kind).toBe(Kind.BATCH);
    const recs = batch.records.map((x) => ({ op: x.opcode, voice: x.voiceId, frame: x.frame }));
    // The writer sorts by frame (asap first).
    expect(recs).toEqual([
      { op: Op.BUS_RAMP, voice: 3, frame: -1 },
      { op: Op.BUS_SLOT, voice: expect.any(Number), frame: 9_600 },
      { op: Op.BUS_RAMP, voice: 1, frame: 12_800 },
    ]);
    const [first, slot, last] = batch.records;
    expect(readBusRamp(first!.view, first!.off)).toMatchObject({ voiceId: 3, gain: 0.5, frames: 480 });
    expect(readBusSlot(slot!.view, slot!.off)).toMatchObject({ slot: 2, parent: 0 });
    expect(readBusRamp(last!.view, last!.off)).toMatchObject({ voiceId: 1, gain: 0.25, frames: 96 });
  });

  it("lists a REPLAY's records too", () => {
    const link = recordingLink();
    const b = new ReplayBuilder();
    b.record(16, (view, off) => writeReset(view, off, { voiceId: 0, frameOffset: ASAP, keepClips: 0 }));
    b.post(link, 4_800, true);
    const batch = batchRecords(link.posted[0]!)!;
    expect(batch.kind).toBe(Kind.REPLAY);
    expect(batch.records.map((x) => [x.opcode, x.frame])).toEqual([[Op.RESET, -1]]);
    expect(readReset(batch.records[0]!.view, batch.records[0]!.off).keepClips).toBe(0);
  });

  it("anything else is not a batch: a STATUS block, a buffer too short for a header", () => {
    const status = new ArrayBuffer(STATUS_BUFFER_BYTES);
    writeStatus(new DataView(status), 0, makeStatusBlock({}), 1);
    expect(batchRecords(status)).toBeNull();
    expect(batchRecords(new ArrayBuffer(8))).toBeNull();
  });
});
