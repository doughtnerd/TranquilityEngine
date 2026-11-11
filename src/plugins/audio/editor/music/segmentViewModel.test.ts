// Ed2: the segment view model. The viewport maths and `findSegment` are the lead's and tested here; the `L-Ed2a` cases
// (gridLines, tempoLane, nearestGridTicks) are skipped until that leaf fills its stubs and un-skips them.
import { describe, expect, it } from "vitest";
import { compileTempoMap } from "../../../../engine/audio/musicGrid";
import type { TempoMarker } from "../../../../engine/audio/musicFormat";
import {
  clampViewport, fitViewport, followPlayhead, gridLines, nearestGridTicks, scrollBy, secondsToX, tempoLane, xToSeconds, zoomAt,
  type Viewport,
} from "./segmentViewModel";

const m = (at: string, bpm: number, beatsPerBar = 4, beatUnit = 4): TempoMarker => ({ at, bpm, beatsPerBar, beatUnit });
/** 120 bpm 4/4 = 0.5 s per beat, 2 s per bar. */
const steady = () => compileTempoMap([m("1:1:0", 120)], 0);
/** 120 bpm 4/4 for bars 1-2 (4 s), then 60 bpm 3/4 from bar 3 (1 s per beat, 3 s per bar). */
const changing = () => compileTempoMap([m("1:1:0", 120), m("3:1:0", 60, 3)], 0);
const view = (startSeconds: number, pxPerSecond: number, widthPx: number): Viewport => ({ startSeconds, pxPerSecond, widthPx });

describe("viewport maths", () => {
  it("maps seconds and x both ways", () => {
    const v = view(2, 50, 400);
    expect(secondsToX(v, 3)).toBe(50);
    expect(xToSeconds(v, 50)).toBe(3);
  });

  it("zoomAt keeps the second under the anchor still", () => {
    const v = view(0, 100, 800);
    const z = zoomAt(v, 2, 300, 100);
    expect(z.pxPerSecond).toBe(200);
    expect(xToSeconds(z, 300)).toBeCloseTo(xToSeconds(v, 300), 9);
  });

  it("clamps the scale and the scroll", () => {
    expect(clampViewport(view(0, 1e9, 100), 10).pxPerSecond).toBe(2000);
    expect(clampViewport(view(0, 0.0001, 100), 10).pxPerSecond).toBe(0.5);
    expect(scrollBy(view(0, 100, 500), -1000, 10).startSeconds).toBe(0);
    expect(scrollBy(view(0, 100, 500), 1e6, 10).startSeconds).toBeCloseTo(5, 9); // 10 s clip, 5 s on screen
  });

  it("fits the whole clip and follows a playhead that left the view", () => {
    const fit = fitViewport(500, 10);
    expect(fit.pxPerSecond).toBe(50);
    const v = view(0, 100, 500);
    expect(followPlayhead(v, 2, 60)).toBe(v);
    expect(xToSeconds(followPlayhead(v, 20, 60), 125)).toBeCloseTo(20, 9);
  });
});

describe("gridLines (L-Ed2a)", () => {
  it.skip("L-Ed2a: draws a bar line every bar and a beat line between, at the span's seconds", () => {
    const lines = gridLines(steady(), view(0, 100, 800), { minBeatPx: 10, minBarPx: 10 });
    expect(lines.filter((l) => l.kind === "bar").map((l) => l.x)).toEqual([0, 200, 400, 600, 800]);
    expect(lines.filter((l) => l.kind === "beat").length).toBe(12);
    expect(lines[0]).toMatchObject({ bar: 1, beat: 1, ticks: 0, label: "1" });
  });

  it.skip("L-Ed2a: a tempo change spaces the beats differently after its marker, and the marker is a line", () => {
    const lines = gridLines(changing(), view(0, 100, 1200), { minBeatPx: 10, minBarPx: 10 });
    const bars = lines.filter((l) => l.kind === "bar");
    expect(bars.map((l) => [l.bar, l.x])).toEqual([[1, 0], [2, 200], [3, 400], [4, 700], [5, 1000]]);
    expect(lines.find((l) => l.marker === 1)).toMatchObject({ bar: 3, beat: 1, kind: "bar", x: 400 });
    expect(lines.filter((l) => l.x > 400 && l.kind === "beat").map((l) => l.x)).toEqual([500, 600, 800, 900, 1100, 1200]);
  });

  it.skip("L-Ed2a: a metre change starts a new bar at its marker and the bars after it follow the new metre", () => {
    const map = compileTempoMap([m("1:1:0", 120, 4), m("2:1:0", 120, 3)], 0);
    const lines = gridLines(map, view(0, 100, 800), { minBeatPx: 10, minBarPx: 10 });
    expect(lines.filter((l) => l.kind === "bar").map((l) => l.x)).toEqual([0, 200, 350, 500, 650, 800]);
    expect(lines.filter((l) => l.kind === "beat" && l.x > 200 && l.x < 350).map((l) => l.x)).toEqual([250, 300]);
  });

  it.skip("L-Ed2a: a tempo-only marker mid-bar is a beat line carrying its marker index, and the bar keeps its phase", () => {
    const map = compileTempoMap([m("1:1:0", 120), m("1:3:0", 60)], 0);
    const lines = gridLines(map, view(0, 100, 600), { minBeatPx: 10, minBarPx: 10 });
    expect(lines.find((l) => l.marker === 1)).toMatchObject({ kind: "beat", bar: 1, beat: 3, x: 100 });
    expect(lines.filter((l) => l.kind === "bar").map((l) => [l.bar, l.x])).toEqual([[1, 0], [2, 300]]);
  });

  it.skip("L-Ed2a: gridOffset shifts every line, and the pickup before it has no lines", () => {
    const map = compileTempoMap([m("1:1:0", 120)], 1);
    const lines = gridLines(map, view(0, 100, 400), { minBeatPx: 10, minBarPx: 10 });
    expect(lines[0]).toMatchObject({ bar: 1, beat: 1, x: 100 });
    expect(lines.every((l) => l.ticks >= 0)).toBe(true);
  });

  it.skip("L-Ed2a: only the visible span is returned, edges included, and a late view does not walk from tick 0", () => {
    const lines = gridLines(steady(), view(1000, 100, 400), { minBeatPx: 10, minBarPx: 10 });
    expect(lines[0]).toMatchObject({ x: 0, bar: 501 });
    expect(lines.at(-1)!.x).toBeLessThanOrEqual(400);
    expect(lines.length).toBeLessThan(20);
  });

  it.skip("L-Ed2a: zoomed out, bar lines thin by powers of two and beats drop, but a marker's line stays", () => {
    const lines = gridLines(changing(), view(0, 0.5, 300), { minBeatPx: 10, minBarPx: 48 });
    expect(lines.some((l) => l.kind === "beat" && l.marker === undefined)).toBe(false);
    expect(lines.length).toBeLessThan(40);
    expect(lines.find((l) => l.marker === 1)).toBeDefined();
    const labelled = lines.filter((l) => l.label !== undefined);
    expect(labelled.every((l) => (l.bar - 1) % 2 === 0 || l.marker !== undefined)).toBe(true);
  });

  it.skip("L-Ed2a: lines ascend and every x is inside the view", () => {
    const lines = gridLines(changing(), view(1.3, 137, 640));
    expect(lines.map((l) => l.ticks)).toEqual([...lines.map((l) => l.ticks)].sort((a, b) => a - b));
    expect(lines.every((l) => l.x >= 0 && l.x <= 640)).toBe(true);
  });
});

describe("tempoLane (L-Ed2a)", () => {
  it.skip("L-Ed2a: one item per overlapping span with bpm, metre and text", () => {
    const items = tempoLane(changing(), view(0, 100, 1000));
    expect(items.map((i) => [i.index, i.x, i.endX, i.text])).toEqual([[0, 0, 400, "120 bpm 4/4"], [1, 400, Infinity, "60 bpm 3/4"]]);
    expect(items.map((i) => i.metreChange)).toEqual([true, true]);
  });

  it.skip("L-Ed2a: a tempo-only change has no metre in its text and is not a metre change", () => {
    const items = tempoLane(compileTempoMap([m("1:1:0", 120), m("2:1:0", 90)], 0), view(0, 100, 1000));
    expect(items[1]).toMatchObject({ text: "90 bpm", metreChange: false });
  });

  it.skip("L-Ed2a: spans entirely off screen are left out; a span cut by the left edge is kept", () => {
    const items = tempoLane(changing(), view(5, 100, 300));
    expect(items.map((i) => i.index)).toEqual([1]);
    expect(tempoLane(changing(), view(2, 100, 600)).map((i) => i.index)).toEqual([0, 1]);
  });

  it.skip("L-Ed2a: fractional bpm print as the shortest decimal with at most two places", () => {
    const items = tempoLane(compileTempoMap([m("1:1:0", 97.5)], 0), view(0, 100, 100));
    expect(items[0]!.text).toBe("97.5 bpm 4/4");
  });
});

describe("nearestGridTicks (L-Ed2a)", () => {
  it.skip("L-Ed2a: rounds to the nearest beat or bar line, never below 0", () => {
    const v = view(0, 100, 800);
    expect(nearestGridTicks(steady(), v, 74, "beat")).toBe(960); // 0.74 s = 1,421 ticks: beat 2 (960) is nearer than beat 3 (1,920)
    expect(nearestGridTicks(steady(), v, -40, "beat")).toBe(0);
    expect(nearestGridTicks(steady(), v, 290, "bar")).toBe(3840); // 2.9 s is nearer bar 2 (2 s = 3,840 ticks) than bar 3 (4 s)
  });

  it.skip("L-Ed2a: a metre change's marker counts as a bar line", () => {
    const map = compileTempoMap([m("1:1:0", 120, 4), m("2:1:0", 120, 3)], 0);
    // bar 2 starts at 2 s (3,840 ticks) and, in 3/4, bar 3 at 3.5 s (6,720 ticks): 3.3 s is nearer the second
    expect(nearestGridTicks(map, view(0, 100, 800), 330, "bar")).toBe(6720);
  });
});
