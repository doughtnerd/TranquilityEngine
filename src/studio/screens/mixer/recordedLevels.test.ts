import { describe, expect, it } from "vitest";
import type { CaptureKeyframeBus } from "../../../plugins/audio/runtime/capture/format";
import { recordedBusReading, type RecordedMoment } from "./recordedLevels";

const lane = (value: number) => ({ value, target: value });
const bus = (slot: number, over: { runtime?: number; duck?: number } = {}): CaptureKeyframeBus => ({
  slot, gen: 0,
  lanes: { authored: lane(1), runtime: lane(over.runtime ?? 1), snapshot: lane(1), monitor: lane(1), dip: lane(1) },
  duck: over.duck ?? 1, automation: 1,
  authoredMute: false, runtimeMute: false, monitorMute: false, monitorSolo: false, tombstone: false, metered: false,
});
const NAMES = ["Master", "Music", "SFX"];
const nameOf = (slot: number) => NAMES[slot] ?? `bus ${slot}`;

describe("recordedBusReading", () => {
  const moment: RecordedMoment = {
    seconds: 12,
    status: { peaks: [{ l: 0.5, r: 0.7 }, { l: 0.2, r: 0.1 }, { l: 0, r: 0 }] },
    keyframe: { buses: [bus(0), bus(1, { runtime: 0.5, duck: 0.25 })] },
  };

  it("reads a bus's peak (the louder channel) and its runtime and duck lanes at the moment", () => {
    expect(recordedBusReading(moment, nameOf, "Master")).toEqual({ volume: 1, duckGain: 1, peak: 0.7, activeVoices: 0 });
    expect(recordedBusReading(moment, nameOf, "Music")).toEqual({ volume: 0.5, duckGain: 0.25, peak: 0.2, activeVoices: 0 });
  });

  it("reads a bus with no keyframe row at unity", () => {
    expect(recordedBusReading(moment, nameOf, "SFX")).toEqual({ volume: 1, duckGain: 1, peak: 0, activeVoices: 0 });
  });

  it("names buses at the moment's time", () => {
    const seen: number[] = [];
    recordedBusReading(moment, (slot, at) => (seen.push(at), nameOf(slot)), "Music");
    expect(new Set(seen)).toEqual(new Set([12]));
  });

  it("says nothing before the first STATUS, or for a bus the capture never named", () => {
    expect(recordedBusReading({ ...moment, status: null }, nameOf, "Master")).toBeNull();
    expect(recordedBusReading(moment, nameOf, "Voice")).toBeNull();
  });
});
