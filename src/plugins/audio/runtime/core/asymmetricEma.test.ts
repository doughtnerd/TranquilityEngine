// The asymmetric moving average (`asymmetricEma.ts`): its own gains up and down, the floor at 0, non-finite samples.
import { describe, expect, it } from "vitest";
import { asymmetricEmaStep } from "./asymmetricEma";

describe("asymmetricEmaStep", () => {
  it("rises by the up gain and falls by the down gain", () => {
    expect(asymmetricEmaStep(40, 100, 0.5, 0.1)).toBeCloseTo(70, 12);
    expect(asymmetricEmaStep(70, 20, 0.5, 0.1)).toBeCloseTo(65, 12);
    expect(asymmetricEmaStep(65, 65, 0.5, 0.1)).toBe(65);
  });

  it("never goes below 0", () => {
    expect(asymmetricEmaStep(10, -1000, 0.5, 0.1)).toBe(0);
    expect(asymmetricEmaStep(0, -1000, 0.5, 0.1)).toBe(0);
  });

  it("ignores a sample that isn't a finite number", () => {
    for (const s of [NaN, Infinity, -Infinity]) expect(asymmetricEmaStep(40, s, 0.5, 0.1)).toBe(40);
  });
});
