import { describe, expect, it } from "vitest";
import { METER_FLOOR_DB, dbToGain, formatDb, formatGainDb, gainReductionDb, gainToDb, meterFill } from "./dbScale";

describe("the audio editor's dB scale", () => {
  it("converts gain and dB: -Infinity (never NaN) for 0, negatives and NaN, and back", () => {
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(0.5)).toBeCloseTo(-6.0206, 4);
    expect(gainToDb(0)).toBe(-Infinity);
    expect(gainToDb(-0.1)).toBe(-Infinity);
    expect(gainToDb(NaN)).toBe(-Infinity);
    expect(dbToGain(-Infinity)).toBe(0);
    expect(dbToGain(NaN)).toBe(0);
    expect(dbToGain(-20)).toBeCloseTo(0.1, 12);
  });

  it("maps linear peaks onto a dB bar from the floor to 0 dB", () => {
    expect(METER_FLOOR_DB).toBe(-60);
    expect(meterFill(0)).toBe(0);
    expect(meterFill(NaN)).toBe(0);
    expect(meterFill(10 ** (METER_FLOOR_DB / 20) / 2)).toBe(0);
    expect(meterFill(1)).toBe(1);
    expect(meterFill(4)).toBe(1);
    expect(meterFill(10 ** (-30 / 20))).toBeCloseTo(0.5, 6);
  });

  it("formats a dB figure to one decimal, silence as -inf dB", () => {
    expect(formatDb(-Infinity)).toBe("-inf dB");
    expect(formatDb(NaN)).toBe("-inf dB");
    expect(formatDb(Infinity)).toBe("+inf dB");
    expect(formatDb(-6.0206)).toBe("-6.0 dB");
    expect(formatDb(0)).toBe("0.0 dB");
  });

  it("formats a gain as the fader's signed readout, -inf under the floor", () => {
    expect(formatGainDb(0)).toBe("-inf");
    expect(formatGainDb(1)).toBe("0.0 dB");
    expect(formatGainDb(0.5)).toBe("-6.0 dB");
    expect(formatGainDb(2)).toBe("+6.0 dB");
    expect(formatGainDb(0.0001)).toBe("-inf");
  });

  it("gives the gain reduction: 0 for a gain of 1 and for nonsense, -20 log10 otherwise, 99 for silence", () => {
    expect(gainReductionDb(1)).toBe(0);
    expect(gainReductionDb(1.5)).toBe(0);
    expect(gainReductionDb(NaN)).toBe(0);
    expect(gainReductionDb(0.5)).toBeCloseTo(6.0206, 4);
    expect(gainReductionDb(0.4)).toBeCloseTo(7.9588, 4);
    expect(gainReductionDb(0)).toBe(99);
    expect(gainReductionDb(1e-9)).toBe(99);
  });
});
