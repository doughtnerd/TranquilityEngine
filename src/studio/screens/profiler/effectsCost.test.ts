// The Profiler's effects-cost track (ADR 0348, 0345): the CPU meter's estimated share per section, read from a capture's
// STATUS records through the Profiler's data reader, planned after Load once fitted, and its value at the cursor.
import { describe, expect, it } from "vitest";
import { QUANTA_PER_STATUS, QUANTUM_MS, open, records, timeOf, type Fields } from "../../../plugins/audio/editor/mix/tracks/cpuCountersTestSupport";
import { effectsCost, effectsCostText } from "./effectsCostModel";
import { ProfilerDataReader } from "./profilerData";

/** `share` of every quantum busy; voices do three times the buses' work. */
const steady = (share: number) => (k: number): Fields => ({
  quantaTotal: (k + 1) * QUANTA_PER_STATUS,
  busyMsTotal: (k + 1) * QUANTA_PER_STATUS * QUANTUM_MS * share,
  clockStepMs: 1,
  wuVoices: (k + 1) * 30,
  wuBuses: (k + 1) * 10,
});

describe("the effects-cost track", () => {
  it("draws each section's estimated share once the meter is fitted, after Load", async () => {
    const n = 320;
    const source = await open(records(n, steady(0.4)));
    const data = await new ProfilerDataReader(source).refresh();
    expect(data.tracks.map((t) => t.id).slice(0, 2)).toEqual(["load", "effects"]);
    const cost = data.effects!;
    expect(cost.lanes.map((l) => l.label)).toEqual(["Voices", "Buses", "Spatial", "Music", "Loudness"]);
    expect(cost.peak).toBeGreaterThanOrEqual(1000);
    const t = timeOf(source, n - 1);
    const text = effectsCostText(cost, t)!;
    expect(text).toMatch(/^Voices \d+‰ · Buses \d+‰$/);
    const [voices, buses] = [...text.matchAll(/(\d+)‰/g)].map((m) => Number(m[1]));
    expect(voices! / buses!).toBeCloseTo(3, 0);
    source.close();
  });

  it("has no track before the meter is fitted, and no value before its first sample", async () => {
    const source = await open(records(40, steady(0.4)));
    const data = await new ProfilerDataReader(source).refresh();
    expect(data.effects).toBeNull();
    expect(data.tracks.some((t) => t.id === "effects")).toBe(false);
    source.close();
    expect(effectsCost(undefined)).toBeNull();
    expect(effectsCost([{ times: [], values: [], color: "accent" }])).toBeNull();
    const cost = effectsCost([{ times: [1, 2], values: [100, 300], color: "accent", yMax: 1200 }])!;
    expect(cost.peak).toBe(1200);
    expect(effectsCostText(cost, 0.5)).toBeNull();
    expect(effectsCostText(cost, 2)).toBe("Voices 300‰");
  });
});
