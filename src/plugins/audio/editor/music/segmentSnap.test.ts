// Ed3: `snapTicks`.
import { describe, expect, it } from "vitest";
import { compileTempoMap, nextBarTicks } from "../../../../engine/audio/musicGrid";
import type { TempoMarker } from "../../../../engine/audio/musicFormat";
import { SNAP_MODES, SNAP_STEP_TICKS, snapTicks } from "./segmentSnap";

const m = (at: string, bpm: number, beatsPerBar = 4, beatUnit = 4): TempoMarker => ({ at, bpm, beatsPerBar, beatUnit });
/** 4/4: a beat is 960 ticks, a bar 3840. */
const steady = () => compileTempoMap([m("1:1:0", 120)], 0);
/** 4/4 for bars 1-2 (bar lines 0, 3840), then 3/4 from 3:1:0 = tick 7680 (bar lines 7680, 10560, 13440). */
const changing = () => compileTempoMap([m("1:1:0", 120), m("3:1:0", 60, 3)], 0);
/** A tempo-only marker on beat 3 of bar 1 (tick 1920): bar lines stay 0, 3840, 7680. */
const midBar = () => compileTempoMap([m("1:1:0", 120), m("1:3:0", 90)], 0);

describe("snapTicks (L-Ed3a)", () => {
  it("L-Ed3a: off rounds to an integer and never goes negative", () => {
    const map = steady();
    expect(snapTicks(map, 1234.4, "off")).toBe(1234);
    expect(snapTicks(map, 1234.5, "off")).toBe(1235);
    expect(snapTicks(map, -50, "off")).toBe(0);
    expect(snapTicks(map, NaN, "off")).toBe(0);
  });

  it("L-Ed3a: beat snaps to the nearest multiple of 960, a tie going later", () => {
    const map = steady();
    expect(snapTicks(map, 1439, "beat")).toBe(960);
    expect(snapTicks(map, 1441, "beat")).toBe(1920);
    expect(snapTicks(map, 480, "beat")).toBe(960);
    expect(snapTicks(map, 479, "beat")).toBe(0);
    expect(snapTicks(map, -700, "beat")).toBe(0);
    expect(snapTicks(compileTempoMap([m("1:1:0", 120)], 0.5), 1441, "beat")).toBe(1920); // gridOffset does not matter
  });

  it("L-Ed3a: half-beat and quarter-beat snap to multiples of 480 and 240", () => {
    const map = steady();
    expect(SNAP_STEP_TICKS).toEqual({ beat: 960, "half-beat": 480, "quarter-beat": 240 });
    expect(snapTicks(map, 700, "half-beat")).toBe(480);
    expect(snapTicks(map, 721, "half-beat")).toBe(960);
    expect(snapTicks(map, 130, "quarter-beat")).toBe(240);
    expect(snapTicks(map, 100, "quarter-beat")).toBe(0);
    expect(snapTicks(map, 120, "quarter-beat")).toBe(240); // tie
  });

  it("L-Ed3a: bar snaps to the nearest bar line of a steady metre, a tie going later", () => {
    const map = steady();
    expect(snapTicks(map, 1900, "bar")).toBe(0);
    expect(snapTicks(map, 1921, "bar")).toBe(3840);
    expect(snapTicks(map, 1920, "bar")).toBe(3840);
    expect(snapTicks(map, 5000, "bar")).toBe(3840);
    expect(snapTicks(map, -10, "bar")).toBe(0);
  });

  it("L-Ed3a: bar follows the metre in force: after a 3/4 change the lines are 7680, 10560, 13440", () => {
    const map = changing();
    expect(snapTicks(map, 7600, "bar")).toBe(7680); // across the change: the marker is a bar line
    expect(snapTicks(map, 9000, "bar")).toBe(7680);
    expect(snapTicks(map, 9200, "bar")).toBe(10560);
    expect(snapTicks(map, 12100, "bar")).toBe(13440);
    expect(snapTicks(map, 10000, "beat")).toBe(9600);
  });

  it("L-Ed3a: a tempo-only marker mid-bar does not move the bar lines", () => {
    const map = midBar();
    expect(snapTicks(map, 3000, "bar")).toBe(3840);
    expect(snapTicks(map, 2000, "bar")).toBe(3840);
    expect(snapTicks(map, 1800, "bar")).toBe(0);
  });

  it("L-Ed3a: every mode returns an integer on its grid that snaps to itself, and bar agrees with nextBarTicks", () => {
    for (const map of [steady(), changing(), midBar()]) {
      for (let t = -100; t < 16000; t += 137.3) {
        for (const mode of SNAP_MODES) {
          const r = snapTicks(map, t, mode);
          expect(Number.isInteger(r) && r >= 0).toBe(true);
          expect(snapTicks(map, r, mode)).toBe(r);
          if (mode === "bar") {
            expect(nextBarTicks(map, r)).toBe(r);
            expect(Math.abs(r - t)).toBeLessThanOrEqual(Math.abs(nextBarTicks(map, Math.ceil(Math.max(t, 0))) - t) + 1e-9);
          } else if (mode !== "off") {
            expect(r % SNAP_STEP_TICKS[mode]).toBe(0);
          }
        }
      }
    }
  });
});
