// ADR 0451, "As built: the clamped last frame": the frame rule (count, times) and snapping a time to the frames.
import { describe, expect, it } from "vitest";
import { frameCount, frameTime, snapToFrame } from "./frames";

describe("a clip's frames", () => {
  it("number ceil(duration · rate) + 1, the last at the duration", () => {
    expect(frameCount(1, 30)).toBe(31);
    expect(frameCount(1.01, 30)).toBe(32);
    expect(frameCount(0.8, 30)).toBe(25);
    expect(frameCount(0, 30)).toBe(1);
    expect(frameTime(31, 30, 1.01)).toBe(1.01);
    expect(frameTime(15, 30, 1.01)).toBe(0.5);
  });

  it("snap a time to the nearest frame, the last one at the duration", () => {
    expect(snapToFrame(0.51, 30, 1.01)).toBeCloseTo(0.5, 9);
    expect(snapToFrame(1.004, 30, 1.01)).toBeCloseTo(1, 9);
    // Nearer the last frame (1.01 s) than the grid's 1.0 s: the grid alone never reached it.
    expect(snapToFrame(1.006, 30, 1.01)).toBe(1.01);
    expect(snapToFrame(1.01, 30, 1.01)).toBe(1.01);
    expect(snapToFrame(1.5, 30, 1.01)).toBe(1.01);
    expect(snapToFrame(0.99, 30, 1)).toBe(1);
    expect(snapToFrame(0.51, 30)).toBeCloseTo(0.5, 9);
  });
});
