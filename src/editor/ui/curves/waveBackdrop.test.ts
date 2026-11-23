import { describe, expect, it } from "vitest";
import { levelLanes, peakAmplitude, waveformFromPeaks, type PeakSource } from "./waveBackdrop";

// One second at 100 Hz, 10 frames a bin: quiet for the first half, loud (half scale) for the second.
const src: PeakSource = {
  rate: 100,
  frames: 100,
  levels: [{ binFrames: 10, bins: 10, channels: 1, data: Int16Array.from({ length: 20 }, (_, i) => (i < 10 ? (i % 2 ? 1638 : -1638) : i % 2 ? 16384 : -16384)) }],
};

describe("the waveform behind time curves", () => {
  it("reads the louder peak of the bins a span covers", () => {
    expect(peakAmplitude(src, 0, 0.2)).toBeCloseTo(0.05, 2);
    expect(peakAmplitude(src, 0.45, 0.55)).toBeCloseTo(0.5, 2);
  });

  it("starts at the clip's trim and is silent outside the source", () => {
    const w = waveformFromPeaks(src, { start: 0.5, window: 0.1 });
    expect(w(0.1, {})).toBeCloseTo(0.5, 2);
    expect(w(0.6, {})).toBe(0);
  });

  it("gives the brighter shape the level lanes' dB", () => {
    const lanes = [
      { id: "g", name: "Gain", unit: "dB", min: -24, max: 6, step: 0.1, base: 0, curve: [] },
      { id: "t", name: "Threshold", unit: "dB", min: -60, max: 0, step: 1, base: -20, curve: [] },
    ];
    expect(levelLanes(lanes)).toEqual(["g"]);
    const w = waveformFromPeaks(src, { window: 0.1, levelLanes: ["g"] });
    const [before, after] = w(0.8, { g: -6.0206, t: -20 }) as [number, number];
    expect(before).toBeCloseTo(0.5, 2);
    expect(after).toBeCloseTo(0.25, 2);
  });
});
