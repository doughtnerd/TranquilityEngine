// ADR 0166 M4 (Z4, leaf L-Z4a; api-and-models §4.4): the STATUS header (176 B in M4, 256 B since ADR 0171) and the `musicRings` and `groupStarts`
// sections. Every case compares against the generated `readStatus` / `writeStatus` for the same bytes.
import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  GROUP_START_ABANDONED,
  GROUP_START_HELD,
  GROUP_START_LATE,
  MAX_GROUP_STARTS_PER_BLOCK,
  MAX_MUSIC_RINGS,
  MUSIC_RING_BOUND,
  MUSIC_RING_EPOCH_MASK,
  MUSIC_RING_PRIMED,
  readStatus,
  STATUS_BUFFER_BYTES,
  STATUS_HEADER_BYTES,
  STATUS_WORST_CASE_BYTES,
  WireError,
  writeStatus,
} from "../wire.generated";
import { makeStatusBlock } from "./mirror";
import { StatusReader } from "./statusReader";

const encode = (fields: Parameters<typeof makeStatusBlock>[0]): ArrayBuffer => {
  const buffer = new ArrayBuffer(STATUS_BUFFER_BYTES);
  writeStatus(new DataView(buffer), 0, makeStatusBlock(fields), 1);
  return buffer;
};

const codeOf = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    return (e as WireError).code;
  }
  return -999;
};

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

const m4 = () => ({
  musicRingsOpen: 201,
  streamStartsLate: 202,
  groupsLate: 203,
  groupsHeld: 204,
  groupsAbandoned: 205,
  curvePoolFull: 206,
  maxSlipFrames: 0x0102_0304,
  splitQuanta: 0x0a0b_0c0d,
  voiceSplits: 0x1122_3344,
  reserved: 0x5566_7788,
});

describe("StatusReader, ADR 0166 header and sections (L-Z4a)", () => {
  it("reads every M4 header field (musicRingsOpen 148, streamStartsLate 150, groupsLate 152, groupsHeld 154, groupsAbandoned 156, curvePoolFull 158, maxSlipFrames 160, splitQuanta 164, voiceSplits 168, reserved 172) at its offset, distinct values", () => {
    const buffer = encode({ ...m4() });
    const view = new DataView(buffer);
    expect(view.getUint16(148, true)).toBe(201);
    expect(view.getUint16(150, true)).toBe(202);
    expect(view.getUint16(152, true)).toBe(203);
    expect(view.getUint16(154, true)).toBe(204);
    expect(view.getUint16(156, true)).toBe(205);
    expect(view.getUint16(158, true)).toBe(206);
    expect(view.getUint32(160, true)).toBe(0x0102_0304);
    expect(view.getUint32(164, true)).toBe(0x0a0b_0c0d);
    expect(view.getUint32(168, true)).toBe(0x1122_3344);
    expect(view.getUint32(172, true)).toBe(0x5566_7788);
    const got = new StatusReader().read(buffer);
    expect(got).toEqual(readStatus(buffer));
    expect(got.musicRingsOpen).toBe(201);
    expect(got.streamStartsLate).toBe(202);
    expect(got.groupsLate).toBe(203);
    expect(got.groupsHeld).toBe(204);
    expect(got.groupsAbandoned).toBe(205);
    expect(got.curvePoolFull).toBe(206);
    expect(got.maxSlipFrames).toBe(0x0102_0304);
    expect(got.splitQuanta).toBe(0x0a0b_0c0d);
    expect(got.voiceSplits).toBe(0x1122_3344);
    expect(got.reserved).toBe(0x5566_7788);
  });

  it("reads musicRings and groupStarts after zoneEvents, equal to the generated readStatus for the same bytes (every older section non-empty too)", () => {
    const buffer = encode({
      ended: [1, 2],
      demoted: [3],
      starved: [4],
      playheads: [{ id: 5, clipFrame: 6 }],
      clipEvents: [{ clipId: 7, code: 1 }],
      streamEvents: [{ id: 8, code: 2 }],
      peaks: [{ l: 0.5, r: 0.25 }],
      beds: [{ bus: 1, voices: 2, work: 3 }],
      zones: [{ kernelId: 9, state: 3, pad: 0, quantaSinceInput: 10, wetPeak: 0.75 }],
      zoneEvents: [{ slot: 1, code: 1, reserved: 0 }],
      musicRings: [
        { streamId: 11, epochFlags: 0x0000_0001 },
        { streamId: 12, epochFlags: MUSIC_RING_PRIMED | 7 },
      ],
      groupStarts: [
        { groupId: 13, flags: GROUP_START_LATE, slipFrames: 14, startFrameLo: 15, startFrameHi: 16 },
        { groupId: 17, flags: GROUP_START_HELD | GROUP_START_ABANDONED, slipFrames: 18, startFrameLo: 19, startFrameHi: 20 },
      ],
    });
    const got = new StatusReader().read(buffer);
    expect(got).toEqual(readStatus(buffer));
    expect(got.zoneEvents).toEqual([{ slot: 1, code: 1, reserved: 0 }]);
    expect(got.musicRings).toEqual([
      { streamId: 11, epochFlags: 1 },
      { streamId: 12, epochFlags: MUSIC_RING_PRIMED | 7 },
    ]);
    expect(got.groupStarts).toEqual([
      { groupId: 13, flags: 1, slipFrames: 14, startFrameLo: 15, startFrameHi: 16 },
      { groupId: 17, flags: 6, slipFrames: 18, startFrameLo: 19, startFrameHi: 20 },
    ]);
  });

  it("a message with every section at its cap is the M3 + M4 part of STATUS_WORST_CASE_BYTES (17,824 B less the 1,552 B of M5 sections, which `StatusReader` reads in Wa2) and reads back equal to readStatus (16 musicRings, 8 groupStarts)", () => {
    const ids = Array.from({ length: 1024 }, (_, i) => i + 1);
    const buffer = new ArrayBuffer(STATUS_BUFFER_BYTES);
    const n = writeStatus(
      new DataView(buffer),
      0,
      makeStatusBlock({
        ...m4(),
        ended: ids,
        demoted: ids,
        starved: ids,
        playheads: Array.from({ length: 256 }, (_, i) => ({ id: i, clipFrame: i })),
        clipEvents: Array.from({ length: 64 }, (_, i) => ({ clipId: i, code: 1 })),
        streamEvents: Array.from({ length: 64 }, (_, i) => ({ id: i, code: 2 })),
        peaks: Array.from({ length: 32 }, (_, i) => ({ l: i, r: -i })),
        beds: Array.from({ length: 4 }, (_, i) => ({ bus: i, voices: i, work: i })),
        zones: Array.from({ length: 4 }, (_, i) => ({ kernelId: i, state: 3, pad: 0, quantaSinceInput: i, wetPeak: 0.5 })),
        zoneEvents: Array.from({ length: 16 }, (_, i) => ({ slot: i % 4, code: 1 + (i % 3), reserved: 0 })),
        musicRings: Array.from({ length: MAX_MUSIC_RINGS }, (_, i) => ({ streamId: i + 1, epochFlags: MUSIC_RING_BOUND | i })),
        groupStarts: Array.from({ length: MAX_GROUP_STARTS_PER_BLOCK }, (_, i) => ({
          groupId: i,
          flags: GROUP_START_LATE,
          slipFrames: i,
          startFrameLo: i,
          startFrameHi: 0,
        })),
      }),
      1,
    );
    expect(n).toBe(STATUS_WORST_CASE_BYTES - (9 * 16 + 288 * 4 + 32 * 8)); // the M5 sections are empty here
    expect(STATUS_WORST_CASE_BYTES).toBe(17_824);
    const got = new StatusReader().read(buffer);
    expect(got).toEqual(readStatus(buffer));
    expect(got.musicRings).toHaveLength(16);
    expect(got.groupStarts).toHaveLength(8);
  });

  it("musicRings above MAX_MUSIC_RINGS and groupStarts above MAX_GROUP_STARTS_PER_BLOCK throw WireError OVERSIZE with the messages readStatus gives", () => {
    const reader = new StatusReader();
    const good = encode({
      musicRings: [{ streamId: 1, epochFlags: 0 }],
      groupStarts: [{ groupId: 1, flags: 0, slipFrames: 0, startFrameLo: 0, startFrameHi: 0 }],
    });
    const patched = (offset: number, value: number): ArrayBuffer => {
      const copy = good.slice(0);
      new DataView(copy).setUint16(offset, value, true);
      return copy;
    };
    const badRings = patched(144, MAX_MUSIC_RINGS + 1);
    const badGroups = patched(146, MAX_GROUP_STARTS_PER_BLOCK + 1);
    expect(codeOf(() => readStatus(badRings))).toBe(ErrorCode.OVERSIZE);
    expect(codeOf(() => reader.read(badRings))).toBe(ErrorCode.OVERSIZE);
    expect(messageOf(() => reader.read(badRings))).toBe(messageOf(() => readStatus(badRings)));
    expect(messageOf(() => reader.read(badRings))).toBe("STATUS: musicRings overrun");
    expect(codeOf(() => readStatus(badGroups))).toBe(ErrorCode.OVERSIZE);
    expect(codeOf(() => reader.read(badGroups))).toBe(ErrorCode.OVERSIZE);
    expect(messageOf(() => reader.read(badGroups))).toBe(messageOf(() => readStatus(badGroups)));
    expect(messageOf(() => reader.read(badGroups))).toBe("STATUS: groupStarts overrun");
  });

  it("a musicRings or groupStarts section that overruns bodyBytes throws WireError OVERSIZE and leaves the previous block unchanged (M4 fields too)", () => {
    const reader = new StatusReader();
    reader.read(
      encode({
        currentFrame: 55,
        musicRingsOpen: 7,
        maxSlipFrames: 9,
        musicRings: [{ streamId: 9, epochFlags: 9 }],
        groupStarts: [{ groupId: 9, flags: 9, slipFrames: 9, startFrameLo: 9, startFrameHi: 9 }],
      }),
    );
    const previous = structuredClone(reader.block);
    // bodyBytes 248: the limit is byte 264, so only 8 of the 16 bytes of two music rings (from 256) fit.
    const rings = encode({
      currentFrame: 99,
      musicRingsOpen: 1,
      maxSlipFrames: 1,
      musicRings: [
        { streamId: 1, epochFlags: 1 },
        { streamId: 2, epochFlags: 2 },
      ],
    });
    new DataView(rings).setUint32(12, STATUS_HEADER_BYTES - 16 + 8, true);
    expect(codeOf(() => readStatus(rings))).toBe(ErrorCode.OVERSIZE);
    expect(codeOf(() => reader.read(rings))).toBe(ErrorCode.OVERSIZE);
    expect(reader.block).toEqual(previous);
    expect(reader.block.currentFrame).toBe(55);
    expect(reader.block.musicRingsOpen).toBe(7);
    expect(reader.block.maxSlipFrames).toBe(9);
    expect(reader.block.musicRings).toEqual([{ streamId: 9, epochFlags: 9 }]);

    // The same cut through one group start (16 B, from 256, only 8 B before byte 264).
    const groups = encode({
      currentFrame: 98,
      groupStarts: [{ groupId: 3, flags: 0, slipFrames: 0, startFrameLo: 0, startFrameHi: 0 }],
    });
    new DataView(groups).setUint32(12, STATUS_HEADER_BYTES - 16 + 8, true);
    expect(codeOf(() => readStatus(groups))).toBe(ErrorCode.OVERSIZE);
    expect(messageOf(() => reader.read(groups))).toBe("STATUS: groupStarts overrun");
    expect(reader.block).toEqual(previous);
  });

  it("reuses the same block, items and arrays across reads (no allocation): a shorter second message shortens musicRings and groupStarts", () => {
    const reader = new StatusReader();
    const a = reader.read(
      encode({
        musicRings: [
          { streamId: 1, epochFlags: 1 },
          { streamId: 2, epochFlags: 2 },
          { streamId: 3, epochFlags: 3 },
        ],
        groupStarts: [
          { groupId: 1, flags: 1, slipFrames: 1, startFrameLo: 1, startFrameHi: 0 },
          { groupId: 2, flags: 2, slipFrames: 2, startFrameLo: 2, startFrameHi: 0 },
        ],
      }),
    );
    const ringItem = a.musicRings[0];
    const ringArray = a.musicRings;
    const groupItem = a.groupStarts[0];
    const groupArray = a.groupStarts;
    const b = reader.read(
      encode({
        musicRings: [{ streamId: 7, epochFlags: MUSIC_RING_PRIMED }],
        groupStarts: [],
      }),
    );
    expect(b).toBe(a);
    expect(b.musicRings).toBe(ringArray);
    expect(b.musicRings[0]).toBe(ringItem);
    expect(b.musicRings).toEqual([{ streamId: 7, epochFlags: MUSIC_RING_PRIMED }]);
    expect(b.groupStarts).toBe(groupArray);
    expect(b.groupStarts).toEqual([]);
    const c = reader.read(
      encode({
        groupStarts: [{ groupId: 5, flags: 4, slipFrames: 6, startFrameLo: 7, startFrameHi: 8 }],
      }),
    );
    expect(c.groupStarts[0]).toBe(groupItem);
    expect(c.groupStarts).toEqual([{ groupId: 5, flags: 4, slipFrames: 6, startFrameLo: 7, startFrameHi: 8 }]);
    expect(c.musicRings).toEqual([]);
  });

  it("the epochFlags bits (epoch 0-29, primed 30, bound 31) and groupStarts flags (late, held, abandoned) come through unsigned (bit 31 does not read negative)", () => {
    const flags = MUSIC_RING_BOUND | MUSIC_RING_PRIMED | 5;
    const buffer = encode({
      musicRings: [{ streamId: 1, epochFlags: flags }],
      groupStarts: [
        { groupId: 2, flags: GROUP_START_LATE | GROUP_START_HELD | GROUP_START_ABANDONED, slipFrames: 3, startFrameLo: 4, startFrameHi: 5 },
      ],
    });
    expect(new DataView(buffer).getUint32(STATUS_HEADER_BYTES + 4, true)).toBe(0xc000_0005);
    const got = new StatusReader().read(buffer);
    expect(got).toEqual(readStatus(buffer));
    const epochFlags = got.musicRings[0]!.epochFlags;
    expect(epochFlags).toBe(0xc000_0005);
    expect(epochFlags).toBeGreaterThanOrEqual(0);
    expect(epochFlags & MUSIC_RING_BOUND).not.toBe(0);
    expect(epochFlags & MUSIC_RING_PRIMED).not.toBe(0);
    expect((epochFlags & MUSIC_RING_EPOCH_MASK) >>> 0).toBe(5);
    expect(got.groupStarts[0]!.flags).toBe(7);
    expect(got.groupStarts[0]!.flags & GROUP_START_ABANDONED).toBe(GROUP_START_ABANDONED);
  });
});
