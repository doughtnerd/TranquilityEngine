// A1.4 (lead): the status reader (api-and-models §4.3).
import { describe, expect, it } from "vitest";
import { ErrorCode, Kind, readStatus, STATUS_BUFFER_BYTES, WireError, writeEnvelope, writeStatus } from "../wire.generated";
import { makeStatusBlock } from "./mirror";
import { StatusReader } from "./statusReader";

const encode = (fields: Parameters<typeof makeStatusBlock>[0]): ArrayBuffer => {
  const buffer = new ArrayBuffer(STATUS_BUFFER_BYTES);
  writeStatus(new DataView(buffer), 0, makeStatusBlock(fields), 1);
  return buffer;
};

const full = () =>
  makeStatusBlock({
    currentFrame: 123_456_789,
    dateMs: 1.7e12,
    pingSeq: 3,
    pingFrameLo: 99,
    underruns: 2,
    lateCommands: 4,
    workUnits: 11,
    workUnitsMax: 12,
    mixedVoices: 5,
    liveVoices: 6,
    flags: 0x11,
    mixedCap: 128,
    loadPermille: 7,
    traps: 1,
    minSlackFrames: -42,
    underrunFrames: 9,
    arenaUsedKB: 100,
    arenaLargestFreeKB: 200,
    abiVersion: 0x100,
    maxLatenessFrames: 8,
    hrtfVoices: 2,
    hrtfLoadFailure: 1,
    ended: [1, 2, 3],
    demoted: [4],
    starved: [5, 6],
    playheads: [{ id: 7, clipFrame: 1000 }],
    clipEvents: [{ clipId: 8, code: 1 }],
    streamEvents: [{ id: 9, code: 2 }],
    peaks: [
      { l: 0.5, r: 0.25 },
      { l: 1, r: 0 },
    ],
  });

describe("StatusReader (§4.3)", () => {
  it("reads every field and section the way readStatus does", () => {
    const buffer = new ArrayBuffer(STATUS_BUFFER_BYTES);
    writeStatus(new DataView(buffer), 0, full(), 1);
    const expected = readStatus(buffer);
    const got = new StatusReader().read(buffer);
    expect(got).toEqual(expected);
    expect(got.ended).toEqual([1, 2, 3]);
    expect(got.peaks[1]).toEqual({ l: 1, r: 0 });
  });

  it("reads views as well as buffers", () => {
    const buffer = new ArrayBuffer(STATUS_BUFFER_BYTES + 8);
    const view = new Uint8Array(buffer, 8);
    writeStatus(new DataView(buffer, 8), 0, full(), 1);
    expect(new StatusReader().read(view)).toEqual(readStatus(view));
  });

  it("refuses what readStatus refuses with the same codes", () => {
    const reader = new StatusReader();
    const codeOf = (fn: () => unknown): number => {
      try {
        fn();
      } catch (e) {
        return (e as WireError).code;
      }
      return -999;
    };
    const good = encode({ ended: [1] });
    const cases: ArrayBuffer[] = [];
    cases.push(new ArrayBuffer(50));
    const badMagic = good.slice(0);
    new DataView(badMagic).setUint32(0, 0, true);
    cases.push(badMagic);
    const badVersion = good.slice(0);
    new DataView(badVersion).setUint16(4, 0x0200, true);
    cases.push(badVersion);
    const wrongKind = good.slice(0);
    writeEnvelope(new DataView(wrongKind), 0, { kind: Kind.BATCH, seq: 0, bodyBytes: 96 });
    cases.push(wrongKind);
    const truncated = good.slice(0);
    new DataView(truncated).setUint32(12, 100_000, true);
    cases.push(truncated);
    const overrun = good.slice(0);
    new DataView(overrun).setUint16(64, 1_000, true);
    cases.push(overrun);
    const bigPeaks = good.slice(0);
    new DataView(bigPeaks).setUint16(72, 33, true);
    cases.push(bigPeaks);
    for (const c of cases) {
      const expected = codeOf(() => readStatus(c));
      expect(expected).not.toBe(-999);
      expect(codeOf(() => reader.read(c))).toBe(expected);
    }
    expect(ErrorCode.TRUNCATED).toBeDefined();
  });

  it("a refused message leaves the block as it was", () => {
    const reader = new StatusReader();
    reader.read(encode({ currentFrame: 55, ended: [1, 2] }));
    const bad = encode({ currentFrame: 99 });
    new DataView(bad).setUint16(64, 1_000, true);
    expect(() => reader.read(bad)).toThrow(WireError);
    expect(reader.block.currentFrame).toBe(55);
    expect(reader.block.ended).toEqual([1, 2]);
  });

  it("returns the same block object every call and a shorter second block leaves no stale section entries", () => {
    const reader = new StatusReader();
    const a = reader.read(encode({ ended: [1, 2, 3], playheads: [{ id: 1, clipFrame: 2 }], peaks: [{ l: 1, r: 1 }] }));
    const items = a.playheads[0];
    const b = reader.read(encode({ ended: [9], peaks: [] }));
    expect(b).toBe(a);
    expect(b.ended).toEqual([9]);
    expect(b.playheads).toEqual([]);
    expect(b.peaks).toEqual([]);
    const c = reader.read(encode({ playheads: [{ id: 3, clipFrame: 4 }] }));
    expect(c.playheads[0]).toBe(items); // pooled item objects
    expect(c.playheads[0]).toEqual({ id: 3, clipFrame: 4 });
  });

  it("fills the largest block and then an empty one", () => {
    const reader = new StatusReader();
    const ids = Array.from({ length: 1024 }, (_, i) => i + 1);
    const big = reader.read(encode({ ended: ids, demoted: ids, starved: ids }));
    expect(big.ended).toHaveLength(1024);
    expect(big.starved[1023]).toBe(1024);
    expect(reader.read(encode({})).starved).toHaveLength(0);
  });
});
