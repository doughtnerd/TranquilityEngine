import { describe, expect, it } from "vitest";
import { dbToGain, gainToDb, semitonesToRatio, SILENCE_DB } from "./decibels";

describe("decibels", () => {
  it("is silent at and below the floor", () => {
    expect(SILENCE_DB).toBe(-60);
    expect(dbToGain(-60)).toBe(0);
    expect(dbToGain(-120)).toBe(0);
    expect(dbToGain(-Infinity)).toBe(0);
    expect(dbToGain(-59.9)).toBeGreaterThan(0.001);
  });

  it("follows 10^(dB/20) above the floor", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(20)).toBeCloseTo(10, 12);
    expect(dbToGain(-6)).toBeCloseTo(0.501187233627, 12);
    expect(dbToGain(-40)).toBeCloseTo(0.01, 12);
  });

  it("reads an unset (NaN) level as unity", () => {
    expect(dbToGain(Number.NaN)).toBe(1);
  });

  it("converts gain back to dB, the floor for silence", () => {
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(0)).toBe(SILENCE_DB);
    expect(gainToDb(0.001)).toBe(SILENCE_DB);
    expect(gainToDb(dbToGain(-12))).toBeCloseTo(-12, 12);
  });

  it("turns semitones into a rate ratio", () => {
    expect(semitonesToRatio(0)).toBe(1);
    expect(semitonesToRatio(12)).toBe(2);
    expect(semitonesToRatio(-12)).toBe(0.5);
  });
});
