import { describe, expect, it } from "vitest";
import { EMPTY_STATES, chooseEmptyState, chooseEmptyStateKind } from "./emptyStates";

// The spec: the strings of api-and-models.md §7 (the `emptyStates.ts` row), copied here.
const DESIGN = {
  notPlaying: "Not playing",
  notRecording: "Recording starts when the panel opens in Play",
  cpuNotMeasured: "CPU not yet measured",
  notMetered: "Not metered",
  truncated: "Truncated: the ring wrapped",
  babylonNoCpu: "Babylon fallback: no CPU line",
} as const;

describe("EMPTY_STATES", () => {
  it("equals the design's text, one string per state", () => {
    expect(EMPTY_STATES).toEqual(DESIGN);
  });
});

describe("chooseEmptyState", () => {
  const core = { hasCapture: true, playing: true, cpuLoadPermille: 120 };

  it("no capture: Not playing outside Play, the recording message in Play, for every view", () => {
    for (const view of ["cpu", "voices", "buses", "loudness", "music"] as const) {
      expect(chooseEmptyState(view, { playing: false, hasCapture: false })).toBe(DESIGN.notPlaying);
      expect(chooseEmptyState(view, { playing: true, hasCapture: false })).toBe(DESIGN.notRecording);
    }
  });

  it("capture without CPU data: not yet measured, on the CPU view only", () => {
    expect(chooseEmptyState("cpu", { ...core, cpuLoadPermille: null })).toBe(DESIGN.cpuNotMeasured);
    expect(chooseEmptyState("cpu", { hasCapture: true, playing: false })).toBe(DESIGN.cpuNotMeasured);
    expect(chooseEmptyState("cpu", core)).toBeNull();
    expect(chooseEmptyState("cpu", { ...core, cpuLoadPermille: 0 })).toBeNull();
    expect(chooseEmptyState("voices", { ...core, cpuLoadPermille: null })).toBeNull();
  });

  it("capture without loudness: Not metered, on the loudness view only", () => {
    expect(chooseEmptyState("loudness", { ...core, metered: false })).toBe(DESIGN.notMetered);
    expect(chooseEmptyState("loudness", { ...core, metered: true })).toBeNull();
    expect(chooseEmptyState("buses", { ...core, metered: false })).toBeNull();
  });

  it("Babylon fallback: no CPU line, loudness absent, other views keep their data", () => {
    const babylon = { ...core, mainSideOnly: true, cpuLoadPermille: null };
    expect(chooseEmptyState("cpu", babylon)).toBe(DESIGN.babylonNoCpu);
    expect(chooseEmptyState("loudness", { ...babylon, metered: true })).toBe(DESIGN.notMetered);
    expect(chooseEmptyState("voices", babylon)).toBeNull();
    expect(chooseEmptyState("events", babylon)).toBeNull();
  });

  it("truncated capture: the message only before the first keyframe", () => {
    expect(chooseEmptyState("voices", { ...core, truncated: true, beforeFirstKeyframe: true })).toBe(DESIGN.truncated);
    expect(chooseEmptyState("voices", { ...core, truncated: true, beforeFirstKeyframe: false })).toBeNull();
    expect(chooseEmptyState("voices", { ...core, truncated: false, beforeFirstKeyframe: true })).toBeNull();
  });

  it("returns the kind", () => {
    expect(chooseEmptyStateKind("cpu", { hasCapture: true, playing: true, mainSideOnly: true })).toBe("babylonNoCpu");
    expect(chooseEmptyStateKind("voices", core)).toBeNull();
  });
});
