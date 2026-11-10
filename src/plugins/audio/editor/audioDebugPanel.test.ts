import { describe, expect, it } from "vitest";
import { MAX_VOICE_ROWS, groupByEvent, lateStartCount, voiceRows } from "./AudioDebugPanel";
import type { EventDebugRow } from "../runtime/events/eventRuntime";

type V = Parameters<typeof voiceRows>[0][number];
const voice = (id: number, audibility: number, state: V["state"] = "playing", priority = 128, event: number | null = null): V => ({
  id, clip: `c${id}`, bus: "SFX", world: null, state, priority, gain: 1, pitch: 1, audibility, playheadSeconds: null, owner: null, event,
});
const row = (id: number, lateStarts = 0): EventDebugRow => ({ id, asset: `e${id}.audioevent.json`, world: 0, voices: 1, parameters: {}, lateStarts });

describe("AudioDebugPanel voice rows", () => {
  it("shows every voice when there are few", () => {
    const r = voiceRows([voice(1, 0.2), voice(2, 0.9)]);
    expect(r.rows.map((v) => v.id)).toEqual([1, 2]);
    expect(r.hidden).toBe(0);
  });

  it("shows only the most audible voices of thousands and counts the rest by state", () => {
    const voices = Array.from({ length: 4096 }, (_, i) => voice(i + 1, (i % 1000) / 1000, i % 3 === 0 ? "virtual" : "playing"));
    const r = voiceRows(voices);
    expect(r.rows).toHaveLength(MAX_VOICE_ROWS);
    expect(r.rows.every((v, i) => i === 0 || r.rows[i - 1]!.audibility >= v.audibility)).toBe(true);
    expect(r.rows[0]!.audibility).toBe(0.999);
    expect(r.hidden).toBe(4096 - MAX_VOICE_ROWS);
    expect(Object.values(r.hiddenByState).reduce((a, b) => a + b, 0)).toBe(r.hidden);
  });
});

describe("AudioDebugPanel event grouping (ADR 0158)", () => {
  it("groups voices under their event instance and leaves the others as they were", () => {
    const rows = [voice(1, 1, "playing", 128, 5), voice(2, 1), voice(3, 1, "playing", 128, 6), voice(4, 1, "playing", 128, 5)];
    const g = groupByEvent(rows, [row(5), row(6)]);
    expect(g.groups.map((x) => [x.event.id, x.voices.map((v) => v.id)])).toEqual([[5, [1, 4]], [6, [3]]]);
    expect(g.ungrouped.map((v) => v.id)).toEqual([2]);
  });

  it("a voice whose instance isn't listed (already ended) or has no event stays ungrouped", () => {
    const g = groupByEvent([voice(1, 1, "playing", 128, 9), voice(2, 1, "playing", 128, null), { ...voice(3, 1), event: undefined }], [row(5)]);
    expect(g.groups).toEqual([]);
    expect(g.ungrouped.map((v) => v.id)).toEqual([1, 2, 3]);
  });

  it("without any event rows everything is ungrouped, in order", () => {
    const g = groupByEvent([voice(2, 1), voice(1, 1)], undefined);
    expect(g.groups).toEqual([]);
    expect(g.ungrouped.map((v) => v.id)).toEqual([2, 1]);
  });

  it("counts the clips events started late", () => {
    expect(lateStartCount([row(1, 2), row(2), row(3, 3)])).toBe(5);
    expect(lateStartCount(undefined)).toBe(0);
  });
});
