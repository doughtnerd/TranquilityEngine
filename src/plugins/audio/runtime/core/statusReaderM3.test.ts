// ADR 0162 (A1, leaf L-A1b): the status reader's M3 parse (api-and-models §4.3, contract C7): the 144-byte header's
// fields at 112..143 and the `beds`, `zones` and `zoneEvents` sections. Each case compares against the generated
// `readStatus` on the same bytes, so the reader and the codec cannot drift apart.
import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  readStatus,
  STATUS_BUFFER_BYTES,
  STATUS_FLAGS_BED_DECODER_READY,
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

const m3 = () => ({
  bedVoices: 101,
  fxVoices: 102,
  ambisonicVoices: 103,
  zonesActive: 104,
  zonesRinging: 105,
  bedsRefused: 106,
  m3Shed: 107,
  zoneUsedKB: 0x0102_0304,
  workBed: 0x0a0b_0c0d,
  workZones: 0x1122_3344,
});

const codeOf = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    return (e as WireError).code;
  }
  return -999;
};

describe("StatusReader, ADR 0162 header and sections", () => {
  it("reads every M3 header field (bedVoices, fxVoices, ambisonicVoices, zonesActive, zonesRinging, bedsRefused, zoneUsedKB, workBed, workZones) at its offset, distinct values", () => {
    const buffer = encode({ ...m3() });
    const view = new DataView(buffer);
    expect(view.getUint16(112, true)).toBe(101);
    expect(view.getUint16(116, true)).toBe(102);
    expect(view.getUint16(118, true)).toBe(103);
    expect(view.getUint16(120, true)).toBe(104);
    expect(view.getUint16(122, true)).toBe(105);
    expect(view.getUint16(126, true)).toBe(106);
    expect(view.getUint32(132, true)).toBe(0x0102_0304);
    expect(view.getUint32(136, true)).toBe(0x0a0b_0c0d);
    expect(view.getUint32(140, true)).toBe(0x1122_3344);
    const got = new StatusReader().read(buffer);
    expect(got).toEqual(readStatus(buffer));
    expect(got.bedVoices).toBe(101);
    expect(got.fxVoices).toBe(102);
    expect(got.ambisonicVoices).toBe(103);
    expect(got.zonesActive).toBe(104);
    expect(got.zonesRinging).toBe(105);
    expect(got.bedsRefused).toBe(106);
    expect(got.m3Shed).toBe(107);
    expect(got.zoneUsedKB).toBe(0x0102_0304);
    expect(got.workBed).toBe(0x0a0b_0c0d);
    expect(got.workZones).toBe(0x1122_3344);
  });

  it("reads beds, zones and zoneEvents after peaks, equal to the generated readStatus for the same bytes (M1/M2 sections non-empty too)", () => {
    const buffer = encode({
      ended: [1, 2],
      demoted: [3],
      starved: [4],
      playheads: [{ id: 5, clipFrame: 6 }],
      clipEvents: [{ clipId: 7, code: 1 }],
      streamEvents: [{ id: 8, code: 2 }],
      peaks: [{ l: 0.5, r: 0.25 }],
      beds: [
        { bus: 1, voices: 2, work: 3 },
        { bus: 4, voices: 5, work: 6 },
      ],
      zones: [
        { kernelId: 9, state: 3, pad: 0, quantaSinceInput: 10, wetPeak: 0.75 },
        { kernelId: 11, state: 5, pad: 0, quantaSinceInput: 65535, wetPeak: 0 },
      ],
      zoneEvents: [
        { slot: 1, code: 1, reserved: 0 },
        { slot: 0, code: 3, reserved: 0 },
      ],
    });
    const got = new StatusReader().read(buffer);
    expect(got).toEqual(readStatus(buffer));
    expect(got.ended).toEqual([1, 2]);
    expect(got.peaks).toEqual([{ l: 0.5, r: 0.25 }]);
    expect(got.beds).toEqual([
      { bus: 1, voices: 2, work: 3 },
      { bus: 4, voices: 5, work: 6 },
    ]);
    expect(got.zones[1]).toEqual({ kernelId: 11, state: 5, pad: 0, quantaSinceInput: 65535, wetPeak: 0 });
    expect(got.zoneEvents).toEqual([
      { slot: 1, code: 1, reserved: 0 },
      { slot: 0, code: 3, reserved: 0 },
    ]);
  });

  it("flags bit 6 (STATUS_FLAGS_BED_DECODER_READY) comes through in flags", () => {
    const buffer = encode({ flags: STATUS_FLAGS_BED_DECODER_READY | 0x1 });
    const got = new StatusReader().read(buffer);
    expect(got.flags).toBe(0x41);
    expect(got.flags & STATUS_FLAGS_BED_DECODER_READY).toBe(STATUS_FLAGS_BED_DECODER_READY);
    expect(got).toEqual(readStatus(buffer));
  });

  it("a message with every section at its cap is STATUS_WORST_CASE_BYTES less the music sections (15,936 B) and reads back equal to readStatus", () => {
    const ids = Array.from({ length: 1024 }, (_, i) => i + 1);
    const buffer = new ArrayBuffer(STATUS_BUFFER_BYTES);
    const n = writeStatus(
      new DataView(buffer),
      0,
      makeStatusBlock({
        ...m3(),
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
      }),
      1,
    );
    expect(n).toBe(STATUS_WORST_CASE_BYTES - 16 * 8 - 8 * 16); // no musicRings or groupStarts here: Z4 reads them
    expect(STATUS_WORST_CASE_BYTES).toBe(16_192); // 15,936 + musicRings 16 x 8 + groupStarts 8 x 16
    const got = new StatusReader().read(buffer);
    expect(got).toEqual(readStatus(buffer));
    expect(got.beds).toHaveLength(4);
    expect(got.zones).toHaveLength(4);
    expect(got.zoneEvents).toHaveLength(16);
  });

  it("bedsActive above MAX_BEDS, zoneSlots above MAX_ZONE_SLOTS, zoneEventCount above 16 throw WireError OVERSIZE", () => {
    const reader = new StatusReader();
    const good = encode({ beds: [{ bus: 1, voices: 1, work: 1 }] });
    const patched = (offset: number, value: number): ArrayBuffer => {
      const copy = good.slice(0);
      new DataView(copy).setUint16(offset, value, true);
      return copy;
    };
    for (const bad of [patched(114, 5), patched(128, 5), patched(124, 17)]) {
      expect(codeOf(() => readStatus(bad))).toBe(ErrorCode.OVERSIZE);
      expect(codeOf(() => reader.read(bad))).toBe(ErrorCode.OVERSIZE);
    }
  });

  it("an M3 section that overruns bodyBytes throws WireError OVERSIZE and leaves the previous block unchanged", () => {
    const reader = new StatusReader();
    reader.read(encode({ ...m3(), currentFrame: 55, beds: [{ bus: 9, voices: 9, work: 9 }] }));
    const bad = encode({
      currentFrame: 99,
      beds: [
        { bus: 1, voices: 2, work: 3 },
        { bus: 4, voices: 5, work: 6 },
      ],
    });
    // bodyBytes 168: the body ends at byte 184, so only 8 of the two beds' 16 bytes (from 176) fit.
    new DataView(bad).setUint32(12, 168, true);
    expect(codeOf(() => readStatus(bad))).toBe(ErrorCode.OVERSIZE);
    expect(codeOf(() => reader.read(bad))).toBe(ErrorCode.OVERSIZE);
    expect(reader.block.currentFrame).toBe(55);
    expect(reader.block.bedVoices).toBe(101);
    expect(reader.block.beds).toEqual([{ bus: 9, voices: 9, work: 9 }]);
  });

  it("reuses the same block, items and arrays across reads (no allocation): a shorter second message shortens each M3 array", () => {
    const reader = new StatusReader();
    const a = reader.read(
      encode({
        beds: [
          { bus: 1, voices: 1, work: 1 },
          { bus: 2, voices: 2, work: 2 },
          { bus: 3, voices: 3, work: 3 },
        ],
        zones: [
          { kernelId: 1, state: 1, pad: 0, quantaSinceInput: 1, wetPeak: 0 },
          { kernelId: 2, state: 2, pad: 0, quantaSinceInput: 2, wetPeak: 0 },
        ],
        zoneEvents: Array.from({ length: 5 }, (_, i) => ({ slot: i, code: 1, reserved: 0 })),
      }),
    );
    const bedItem = a.beds[0];
    const zoneItem = a.zones[0];
    const eventArray = a.zoneEvents;
    const b = reader.read(
      encode({ beds: [{ bus: 7, voices: 8, work: 9 }], zones: [], zoneEvents: [{ slot: 2, code: 3, reserved: 0 }] }),
    );
    expect(b).toBe(a);
    expect(b.beds).toEqual([{ bus: 7, voices: 8, work: 9 }]);
    expect(b.beds[0]).toBe(bedItem);
    expect(b.zones).toEqual([]);
    expect(b.zoneEvents).toBe(eventArray);
    expect(b.zoneEvents).toEqual([{ slot: 2, code: 3, reserved: 0 }]);
    const c = reader.read(encode({ zones: [{ kernelId: 5, state: 4, pad: 0, quantaSinceInput: 6, wetPeak: 0.25 }] }));
    expect(c.zones[0]).toBe(zoneItem);
    expect(c.zones).toEqual([{ kernelId: 5, state: 4, pad: 0, quantaSinceInput: 6, wetPeak: 0.25 }]);
    expect(c.beds).toEqual([]);
    expect(c.zoneEvents).toEqual([]);
  });
});
