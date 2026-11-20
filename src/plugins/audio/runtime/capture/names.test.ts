// ADR 0260: a capture's names over time, through `CaptureNames` over a log as the reader builds it (META's names from the
// start, NAMES records from their instants) and through a real file's summary.
import { describe, expect, it } from "vitest";
import { LOUD_OUTPUT_TAP } from "../wire.generated";
import { RecordType, assembleCapture } from "./format";
import { CaptureNames, captureNames, OUTPUT_NAME, type CaptureNameLog } from "./names";
import { CaptureTimeIndex, openCapture, summarizeCapture } from "./reader";
import { SAMPLE_HEADER, SAMPLE_META, sampleRecords } from "./testSupport";

const log = (over: Partial<CaptureNameLog>): CaptureNameLog => ({ clips: [], buses: [], events: [], parameters: [], snapshots: [], targets: [], ...over });

describe("CaptureNames", () => {
  const names = new CaptureNames(log({
    clips: [[1, "jump.ogg", -Infinity], [2, "land.ogg", 0.5]],
    buses: [[0, "Master", -Infinity], [1, "Music", -Infinity], [1, "Score", 2], [3, "Stingers", 1], [3, "Recycled", 4]],
  }));

  it("answers a bus slot's name as it was at t: the old name before a rename, the new one from it", () => {
    expect(names.bus(1, 1.999)).toBe("Music");
    expect(names.bus(1, 2)).toBe("Score");
    expect(names.bus(1)).toBe("Score"); // no time: the latest
    expect([names.bus(3, 1), names.bus(3, 3.9), names.bus(3, 4)]).toEqual(["Stingers", "Stingers", "Recycled"]);
  });

  it("before an id's first record it reads as that first name", () => {
    expect(names.bus(3, 0)).toBe("Stingers");
    expect(names.clip(2, 0)).toBe("land.ogg");
  });

  it("an id never named reads as its table's word and the id; the output's slot reads Master", () => {
    expect([names.clip(9), names.bus(7), names.event(4), names.parameter(5), names.snapshot(6)]).toEqual(["clip 9", "bus 7", "event 4", "parameter 5", "snapshot 6"]);
    expect(names.bus(LOUD_OUTPUT_TAP)).toBe(OUTPUT_NAME);
    expect(names.find("buses", 7)).toBeUndefined();
  });

  it("finds the slot a name is on at t, and lists the named slots", () => {
    expect(names.slotOf("Music", 1)).toBe(1);
    expect(names.slotOf("Music", 3)).toBeUndefined();
    expect(names.slotOf("Score", 3)).toBe(1);
    expect(names.busSlots(3)).toEqual([[0, "Master"], [1, "Score"], [3, "Stingers"]]);
  });
});

describe("captureNames over a file's summary", () => {
  it("holds META's names from the start and a NAMES record's name from its instant, built once per summary", async () => {
    const records = sampleRecords();
    const c = await openCapture(assembleCapture(SAMPLE_HEADER, SAMPLE_META, records, { index: true }));
    const idx = new CaptureTimeIndex();
    idx.extend(c);
    const summary = summarizeCapture(c, idx);
    const names = captureNames(summary);
    expect(names).toBe(captureNames(summary));
    expect(names.clip(1, -1)).toBe("jump.ogg");
    expect(names.clip(2)).toBe("land.ogg"); // the sample's NAMES record
    expect(summary.names.clips.find(([id]) => id === 2)![2]).toBe(1100 / SAMPLE_HEADER.sampleRate);
    expect(records.some((r) => r.type === RecordType.NAMES)).toBe(true);
  });
});
