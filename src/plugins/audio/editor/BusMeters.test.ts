import { describe, expect, it } from "vitest";
import { METER_FLOOR_DB, meterFill } from "./BusMeters";

describe("bus meter scale", () => {
  it("maps linear peaks onto a dB bar from the floor to 0 dB", () => {
    expect(meterFill(0)).toBe(0);
    expect(meterFill(NaN)).toBe(0);
    expect(meterFill(10 ** (METER_FLOOR_DB / 20) / 2)).toBe(0);
    expect(meterFill(1)).toBe(1);
    expect(meterFill(4)).toBe(1);
    expect(meterFill(10 ** (-30 / 20))).toBeCloseTo(0.5, 6);
  });
});
