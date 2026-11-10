// A3.2-L1: the pure lookahead and ramp rules (lookahead.ts; architecture §4.3, §4.7). Hand-computed numbers: at
// 48 kHz 1 ms is 48 frames, at 44.1 kHz 44.1.
import { describe, expect, it } from "vitest";
import { firstFrame, frameOfTime, isStamped, LOOKAHEAD_MAX_SECONDS, LOOKAHEAD_MIN_FRAMES, lookaheadFrames, RAMP_MAX_MS, RAMP_MIN_MS, rampFrames } from "./lookahead";

describe("lookaheadFrames: L = clamp(2·Δ̄, 1,024 frames, 100 ms)", () => {
  it("has §4.7's constants", () => {
    expect(LOOKAHEAD_MIN_FRAMES).toBe(1024);
    expect(LOOKAHEAD_MAX_SECONDS).toBe(0.1);
    expect([RAMP_MIN_MS, RAMP_MAX_MS]).toEqual([5, 50]);
  });

  it("is 2·Δ̄ inside the clamps", () => {
    // 20 ms at 48 kHz: 2 * 20 * 48 = 1920. 30 ms at 44.1 kHz: 2 * 30 * 44.1 = 2646.
    expect(lookaheadFrames(20, 48_000)).toBe(1920);
    expect(lookaheadFrames(30, 44_100)).toBe(2646);
    // Rounds: 2 * 16.6667 * 48 = 1600.0032 -> 1600; 2 * 12.34 * 44.1 = 1088.388 -> 1088.
    expect(lookaheadFrames(1000 / 60, 48_000)).toBe(1600);
    expect(lookaheadFrames(12.34, 44_100)).toBe(1088);
  });

  it("holds the 1,024-frame floor at high frame rates (144 Hz is 2 × 6.94 ms = 667 frames at 48 kHz)", () => {
    expect(lookaheadFrames(1000 / 144, 48_000)).toBe(1024);
    expect(lookaheadFrames(1000 / 240, 96_000)).toBe(1024);
    // The floor is in frames, so its time shrinks as the rate rises.
    expect(lookaheadFrames(5, 192_000)).toBe(1920);
  });

  it("caps at 100 ms: 4,800 frames at 48 kHz, 4,410 at 44.1 kHz", () => {
    expect(lookaheadFrames(90, 48_000)).toBe(4800);
    expect(lookaheadFrames(250, 44_100)).toBe(4410);
  });

  it("lets the ceiling win where the clamps cross (under 10,240 Hz)", () => {
    // 8 kHz: 100 ms is 800 frames, below the 1,024 floor.
    expect(lookaheadFrames(16, 8_000)).toBe(800);
  });

  it("treats a non-finite, zero or negative interval as no interval: the floor", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) expect(lookaheadFrames(bad, 48_000)).toBe(1024);
  });
});

describe("rampFrames: round(clamp(Δ̄, 5 ms, 50 ms)·sr)", () => {
  it("is one frame interval inside the clamps", () => {
    expect(rampFrames(1000 / 60, 48_000)).toBe(800);
    expect(rampFrames(20, 44_100)).toBe(882);
  });

  it("clamps to 5 ms and 50 ms", () => {
    expect(rampFrames(2, 48_000)).toBe(240);
    expect(rampFrames(100, 48_000)).toBe(2400);
    expect(rampFrames(1000 / 360, 44_100)).toBe(221); // 5 * 44.1 = 220.5 -> 221
  });

  it("treats a non-finite interval as the floor; a negative one clamps to it", () => {
    expect(rampFrames(Number.NaN, 48_000)).toBe(240);
    expect(rampFrames(Number.POSITIVE_INFINITY, 48_000)).toBe(240);
    expect(rampFrames(-1, 48_000)).toBe(240);
  });
});

describe("firstFrame: max(round(F_now + L), previous)", () => {
  it("rounds F_now + L and never goes backwards", () => {
    expect(firstFrame(100_800.4, 1600, 0)).toBe(102_400);
    expect(firstFrame(100_800.6, 1600, 0)).toBe(102_401);
    expect(firstFrame(80_400, 1600, 102_400)).toBe(102_400);
    expect(firstFrame(200_000, 1024, 102_400)).toBe(201_024);
  });
});

describe("frameOfTime and isStamped: the `at` rule (API §1, architecture §4.3)", () => {
  it("frame f is heard at Audio.time f/sr, so `at` maps to round(at·sr)", () => {
    expect(frameOfTime(2, 48_000)).toBe(96_000);
    expect(frameOfTime(1.00001, 44_100)).toBe(44_100); // 44,100.441 -> 44,100
    expect(frameOfTime(1 + 0.6 / 48_000, 48_000)).toBe(48_001);
  });

  it("omitted, non-finite or not after time 0 is 0 (asap)", () => {
    for (const at of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -3, 0.000001]) {
      expect(frameOfTime(at, 48_000)).toBe(0);
    }
  });

  it("stamps only a frame after F_now; a past frame and 0 go asap", () => {
    expect(isStamped(96_001, 96_000)).toBe(true);
    expect(isStamped(96_000, 96_000)).toBe(false);
    expect(isStamped(95_000, 96_000)).toBe(false);
    expect(isStamped(0, -100)).toBe(false);
    // Within L of F_now is still stamped: it may arrive late, which the core counts (§4.4).
    expect(isStamped(96_100, 96_000)).toBe(true);
  });
});
