import { describe, expect, it } from "vitest";
import { meterFill } from "../BusMeters";
import {
  CLIP_PEAK,
  PEAK_FALL_DB_PER_S,
  PEAK_HOLD_MS,
  createMeter,
  readMeter,
  resetClip,
  resetMeter,
  tickMeter,
} from "./meterModel";

const db = (x: number) => Math.pow(10, x / 20);

describe("meter model", () => {
  it("the bar fill equals meterFill for the same input", () => {
    const m = tickMeter(createMeter(), db(-20), 0);
    for (const peak of [0, 1e-5, db(-60), db(-30), db(-6), 1, 3, NaN, -1]) {
      expect(readMeter(m, peak).fill).toBe(meterFill(peak));
    }
  });

  it("holds the peak for the hold time, then falls at the fall rate", () => {
    let m = tickMeter(createMeter(), db(-10), 1000);
    expect(m.hold).toBeCloseTo(db(-10), 12);
    // live peak drops; the hold stays put through the hold time
    m = tickMeter(m, db(-40), 1000 + PEAK_HOLD_MS);
    expect(m.hold).toBeCloseTo(db(-10), 12);
    expect(readMeter(m, db(-40)).holdFill).toBe(meterFill(db(-10)));
    // one second after the hold ends: 20 dB lower
    m = tickMeter(m, db(-40), 1000 + PEAK_HOLD_MS + 1000);
    expect(20 * Math.log10(m.hold)).toBeCloseTo(-10 - PEAK_FALL_DB_PER_S, 9);
  });

  it("falls the same however the ticks are spaced", () => {
    const start = tickMeter(createMeter(), db(-6), 0);
    const one = tickMeter(start, 0, PEAK_HOLD_MS + 500);
    let many = start;
    for (let t = 250; t <= PEAK_HOLD_MS + 500; t += 250) many = tickMeter(many, 0, t);
    expect(many.hold).toBeCloseTo(one.hold, 12);
    expect(20 * Math.log10(one.hold)).toBeCloseTo(-6 - 10, 9);
  });

  it("a higher peak replaces the hold at once and restarts the timer; a lower one under the falling hold doesn't", () => {
    let m = tickMeter(createMeter(), db(-20), 0);
    m = tickMeter(m, db(-5), 100);
    expect(m.hold).toBeCloseTo(db(-5), 12);
    expect(m.holdSinceMs).toBe(100);
    m = tickMeter(m, db(-40), 100 + PEAK_HOLD_MS + 1000); // hold at -25 dB now
    expect(m.hold).toBeCloseTo(db(-25), 9);
    m = tickMeter(m, db(-30), 100 + PEAK_HOLD_MS + 1000);
    expect(m.hold).toBeCloseTo(db(-25), 9);
    m = tickMeter(m, db(-12), 100 + PEAK_HOLD_MS + 1000);
    expect(m.hold).toBeCloseTo(db(-12), 12);
  });

  it("the hold drops to nothing once under the bar's floor", () => {
    let m = tickMeter(createMeter(), db(-30), 0);
    m = tickMeter(m, 0, PEAK_HOLD_MS + 10_000);
    expect(m.hold).toBe(0);
    expect(readMeter(m, 0).holdFill).toBe(0);
  });

  it("a clock that goes backwards is no time passing", () => {
    let m = tickMeter(createMeter(), db(-10), 5000);
    m = tickMeter(m, 0, 1000);
    expect(m.hold).toBeCloseTo(db(-10), 12);
  });

  it("latches the clip at 0 dBFS and keeps it until reset", () => {
    let m = tickMeter(createMeter(), db(-0.1), 0);
    expect(m.clipped).toBe(false);
    m = tickMeter(m, CLIP_PEAK, 50);
    expect(m.clipped).toBe(true);
    m = tickMeter(m, 0, 60_000);
    expect(m.clipped).toBe(true);
    expect(readMeter(m, 0).clipped).toBe(true);
    m = resetClip(m);
    expect(m.clipped).toBe(false);
    expect(tickMeter(m, db(-3), 61_000).clipped).toBe(false);
    expect(tickMeter(resetClip(tickMeter(createMeter(), 1.5, 0)), 1.5, 10).clipped).toBe(true);
  });

  it("resetClip keeps the hold; resetMeter clears both", () => {
    const m = tickMeter(createMeter(), 2, 0);
    expect(resetClip(m).hold).toBe(2);
    expect(resetMeter()).toEqual(createMeter());
  });
});
