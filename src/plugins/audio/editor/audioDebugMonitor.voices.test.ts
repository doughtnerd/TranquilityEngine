// ADR 0157 and 0158 through the monitor (ADR 0220): the voices table (the most audible voices, grouped under their event
// instance), the summary rows and the buses table.
import { describe, expect, it } from "vitest";
import { rowOf, eventRow, snapshot, viewAfter, voice } from "./testing/debugSnapshot";

/** The voices table's ids, as the panel lists them: each group's, then the ungrouped ones. */
const ids = (rows: readonly { id: string }[]) => rows.map((r) => Number(r.id));

describe("voices table", () => {
  it("shows every voice when there are few, titled plainly", () => {
    const v = viewAfter(snapshot({ voices: [voice(1, { audibility: 0.2 }), voice(2, { audibility: 0.9 })] })).voices;
    expect(ids(v.ungrouped)).toEqual([1, 2]);
    expect([v.title, v.more, v.empty]).toEqual(["Voices", null, null]);
  });

  it("says so when there are none", () => {
    expect(viewAfter(snapshot()).voices.empty).toBe("No voices");
  });

  it("shows only the 64 most audible voices of thousands and counts the rest by state", () => {
    const voices = Array.from({ length: 4096 }, (_, i) => voice(i + 1, { audibility: (i % 1000) / 1000, state: i % 3 === 0 ? "virtual" : "playing" }));
    const v = viewAfter(snapshot({ voices })).voices;
    expect(v.ungrouped).toHaveLength(64);
    expect(v.title).toBe("Voices (the 64 most audible of 4096)");
    const shown = ids(v.ungrouped).map((id) => voices[id - 1]!.audibility);
    expect(shown.every((a, i) => i === 0 || shown[i - 1]! >= a)).toBe(true);
    expect(shown[0]).toBe(0.999);
    const [, count, rest] = /^(\d+) more: (.*)$/.exec(v.more!)!;
    expect(Number(count)).toBe(4096 - 64);
    expect(rest!.split(", ").reduce((n, part) => n + Number(part.split(" ")[0]), 0)).toBe(4096 - 64);
  });

  it("groups voices under their event instance, with its header line, and leaves the others as they were", () => {
    const voices = [voice(1, { event: 5 }), voice(2), voice(3, { event: 6 }), voice(4, { event: 5 })];
    const events = [eventRow(5, { voices: 2, parameters: { Speed: 0.5, Surface: "Grass" }, lateStarts: 1 }), eventRow(6)];
    const v = viewAfter(snapshot({ voices, events })).voices;
    expect(v.groups.map((g) => [g.id, ids(g.voices)])).toEqual([[5, [1, 4]], [6, [3]]]);
    expect(ids(v.ungrouped)).toEqual([2]);
    expect(v.groups.map((g) => [g.name, g.meta])).toEqual([
      ["e5.audioevent.json", " #5 · 2 voices · Speed 0.50, Surface Grass · 1 late"],
      ["e6.audioevent.json", " #6 · 1 voice"],
    ]);
  });

  it("a voice whose instance isn't listed (already ended) or has no event stays ungrouped", () => {
    const v = viewAfter(snapshot({ voices: [voice(1, { event: 9 }), voice(2, { event: null }), voice(3)], events: [eventRow(5)] })).voices;
    expect(v.groups).toEqual([]);
    expect(ids(v.ungrouped)).toEqual([1, 2, 3]);
  });

  it("marks the clip-like and state columns for the panel", () => {
    const cols = viewAfter(snapshot()).voices.columns;
    expect(cols.filter((c) => c.kind === "clip").map((c) => c.label)).toEqual(["Source", "Clip"]);
    expect(cols.filter((c) => c.kind === "state").map((c) => c.label)).toEqual(["State"]);
  });
});

describe("summary", () => {
  const value = (s: ReturnType<typeof snapshot>, id: string) => rowOf(viewAfter(s).summary, id).cells;

  it("shows the backend, the sample rate and the base counters", () => {
    const s = snapshot({ core: { backend: "core" }, counters: { underruns: 2, logicalVoices: 7, mixedVoices: 3, mixedCap: 32, hrtfVoices: 1, hrtfLoadFailure: 1, droppedPlays: 4 } });
    const v = viewAfter(s);
    expect(v.summary.map((r) => r.cells[1]!.text)).toEqual(["core", "48000 Hz", "2", "7", "3 / 32", "1 (HRTF data failed to load)", "4", "0", "0"]);
    expect(v.status).toBe("running");
  });

  it("ADR 0220: clips started late is the session total, so it stays counted after the instance ends", () => {
    const late = (events: ReturnType<typeof eventRow>[], lateStarts: number) => value(snapshot({ events, eventTotals: { lateStarts } }), "lateStarts");
    expect(late([eventRow(1, { lateStarts: 2 })], 2).map((c) => c.text)).toEqual(["Clips started late", "2"]);
    expect(late([], 2).map((c) => c.text)).toEqual(["Clips started late", "2"]);
  });

  it("without a session total, it sums the playing instances and says so", () => {
    const cells = value(snapshot({ events: [eventRow(1, { lateStarts: 2 }), eventRow(2, { lateStarts: 3 })] }), "lateStarts");
    expect(cells.map((c) => c.text)).toEqual(["Clips started late (playing instances)", "5"]);
  });
});

describe("buses", () => {
  it("shows gain (hover for the effective gain), the louder peak, voices of the cap, and the bed, amber when lost", () => {
    const bus = { gain: 0.5, effectiveGain: 0.25, peakL: 0.1, peakR: 0.3, voices: 2, maxVoices: 8 };
    const v = viewAfter(snapshot({ buses: [{ name: "Music", ...bus, bed: "parent", bedHost: "Master", bedLost: true }, { name: "SFX", ...bus, maxVoices: null }] })).buses;
    expect(v.columns.map((c) => c.label)).toEqual(["Bus", "Gain", "Peak", "Voices", "Bed"]);
    expect(v.rows.map((r) => r.cells.map((c) => c.text))).toEqual([
      ["Music", "0.50", "0.30", "2 / 8", "parent (Master)"],
      ["SFX", "0.50", "0.30", "2", "-"],
    ]);
    expect(v.rows[0]!.cells[1]!.tip).toBe("Effective 0.25");
    expect(v.rows[0]!.cells[4]!.health).toBe("warn");
    expect(v.rows[1]!.cells[4]!.health).toBeUndefined();
  });
});
