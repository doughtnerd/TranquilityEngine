import { describe, expect, it } from "vitest";
import {
  FADER_FLOOR_DB,
  FADER_MAX_DB,
  FINE_DRAG_SCALE,
  SNAP_RADIUS,
  UNITY_POSITION,
  dbToGain,
  dbToPosition,
  dragGain,
  dragPosition,
  formatDb,
  gainToDb,
  gainToPosition,
  positionToDb,
  positionToGain,
  snapToUnity,
} from "./faderModel";

describe("fader taper", () => {
  it("round trips position -> dB -> position to 1e-9 across the travel", () => {
    for (let i = 1; i <= 1000; i++) {
      const p = i / 1000;
      expect(Math.abs(dbToPosition(positionToDb(p)) - p)).toBeLessThan(1e-9);
      expect(Math.abs(gainToPosition(positionToGain(p)) - p)).toBeLessThan(1e-9);
    }
  });

  it("puts unity at its position and the ends at silence and +6 dB", () => {
    expect(positionToGain(UNITY_POSITION)).toBe(1);
    expect(positionToDb(UNITY_POSITION)).toBe(0);
    expect(gainToPosition(1)).toBe(UNITY_POSITION);
    expect(positionToDb(1)).toBeCloseTo(FADER_MAX_DB, 12);
    expect(positionToGain(1)).toBe(2);
    expect(positionToDb(0)).toBe(-Infinity);
    expect(positionToGain(0)).toBe(0);
    expect(gainToPosition(0)).toBe(0);
    expect(dbToPosition(-Infinity)).toBe(0);
    expect(positionToDb(1e-6)).toBeCloseTo(FADER_FLOOR_DB, 3);
  });

  it("is strictly increasing in dB and gain", () => {
    let db = -Infinity;
    let gain = -1;
    for (let i = 0; i <= 1000; i++) {
      const p = i / 1000;
      if (i > 0) expect(positionToDb(p)).toBeGreaterThan(db);
      else expect(positionToDb(p)).toBe(-Infinity);
      expect(positionToGain(p)).toBeGreaterThan(gain);
      db = positionToDb(p);
      gain = positionToGain(p);
    }
  });

  it("clamps out-of-range positions, dB and gains; NaN is silence", () => {
    expect(positionToGain(-1)).toBe(0);
    expect(positionToGain(5)).toBe(2);
    expect(positionToGain(NaN)).toBe(0);
    expect(dbToPosition(40)).toBe(1);
    expect(dbToPosition(-90)).toBe(0);
    expect(gainToPosition(10)).toBe(1);
    expect(gainToPosition(0.0001)).toBe(0);
    expect(gainToPosition(NaN)).toBe(0);
  });

  it("converts gain and dB", () => {
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(0.5)).toBeCloseTo(-6.0206, 4);
    expect(gainToDb(0)).toBe(-Infinity);
    expect(dbToGain(-Infinity)).toBe(0);
    expect(dbToGain(-20)).toBeCloseTo(0.1, 12);
  });

  it("formats the readout", () => {
    expect(formatDb(0)).toBe("-inf");
    expect(formatDb(1)).toBe("0.0 dB");
    expect(formatDb(0.5)).toBe("-6.0 dB");
    expect(formatDb(2)).toBe("+6.0 dB");
    expect(formatDb(0.0001)).toBe("-inf");
  });
});

describe("fader snapping and fine drag", () => {
  it("snaps to unity within the radius and not outside it", () => {
    expect(snapToUnity(UNITY_POSITION + SNAP_RADIUS * 0.99)).toBe(UNITY_POSITION);
    expect(snapToUnity(UNITY_POSITION - SNAP_RADIUS * 0.99)).toBe(UNITY_POSITION);
    expect(snapToUnity(UNITY_POSITION + SNAP_RADIUS * 1.5)).toBe(UNITY_POSITION + SNAP_RADIUS * 1.5);
    expect(snapToUnity(2)).toBe(1);
    expect(snapToUnity(-1)).toBe(0);
  });

  it("drags from the start position and snaps; fine scales the travel", () => {
    expect(dragPosition(0.5, 0.1)).toBeCloseTo(0.6, 12);
    expect(dragPosition(0.5, 0.26)).toBe(UNITY_POSITION);
    expect(dragPosition(0.5, 0.1, true)).toBeCloseTo(0.5 + 0.1 * FINE_DRAG_SCALE, 12);
    expect(dragPosition(0.9, 5)).toBe(1);
    expect(dragPosition(0.1, -5)).toBe(0);
    // fine travel near unity still snaps once inside the radius
    expect(dragPosition(UNITY_POSITION - 0.1, 0.9, true)).toBe(UNITY_POSITION);
  });

  it("drags a gain", () => {
    expect(dragGain(1, 0)).toBe(1);
    expect(dragGain(1, 0.25)).toBe(2);
    expect(dragGain(1, -1)).toBe(0);
    expect(dragGain(0.5, 0.1)).toBeGreaterThan(0.5);
  });
});
