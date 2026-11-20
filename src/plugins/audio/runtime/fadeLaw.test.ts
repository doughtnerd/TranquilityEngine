// ADR 0248: the one fade-law module main computes with, checked against the seam goldens' independent reference
// (`golden/seamReference.ts` `lawValue`, a port of the Rust core's laws) and the wire's codes.
import { describe, expect, it } from "vitest";
import type { FadeLaw } from "./backend";
import { fadeInLaw, fadeLawCode, fadeLawOfCode, fadeLawWeight, fadeOutLaw } from "./fadeLaw";
import { lawValue } from "./golden/seamReference";
import { FadeLaw as FadeLawCode } from "./wire.generated";

const LAWS: readonly FadeLaw[] = ["linear", "sCurve", "equalPowerIn", "equalPowerOut"];

describe("fade laws (fadeLaw.ts)", () => {
  it("weights agree with the seam reference's laws at every phase, both directions", () => {
    for (const law of LAWS) {
      for (let k = 0; k <= 20; k++) {
        const u = k / 20;
        expect(0.2 + (0.9 - 0.2) * fadeLawWeight(law, u), `${law} up at ${u}`).toBeCloseTo(lawValue(law, 0.2, 0.9, u), 12);
        expect(1 + (0 - 1) * fadeLawWeight(law, u), `${law} down at ${u}`).toBeCloseTo(lawValue(law, 1, 0, u), 12);
      }
    }
  });

  it("clamps the phase", () => {
    for (const law of LAWS) {
      expect(fadeLawWeight(law, -1)).toBeCloseTo(0, 15);
      expect(fadeLawWeight(law, 2)).toBeCloseTo(1, 15);
    }
  });

  it("maps each law to the wire's code and back; unknown codes are linear", () => {
    expect(LAWS.map(fadeLawCode)).toEqual([FadeLawCode.Linear, FadeLawCode.SCurve, FadeLawCode.EqualPowerIn, FadeLawCode.EqualPowerOut]);
    expect(fadeLawCode(undefined)).toBe(FadeLawCode.Linear);
    for (const law of LAWS) expect(fadeLawOfCode(fadeLawCode(law))).toBe(law);
    // Only bits 0-2 are the law (the shape word carries the start phase above them).
    expect(fadeLawOfCode(fadeLawCode("sCurve") | (0x8000 << 16))).toBe("sCurve");
    expect(fadeLawOfCode(7)).toBe("linear");
  });

  it("an equal-power transition fades in and out under the matching pair; the others use their own law both ways", () => {
    expect([fadeInLaw("equalPower"), fadeOutLaw("equalPower")]).toEqual(["equalPowerIn", "equalPowerOut"]);
    expect([fadeInLaw("sCurve"), fadeOutLaw("sCurve")]).toEqual(["sCurve", "sCurve"]);
    expect([fadeInLaw("linear"), fadeOutLaw("linear")]).toEqual(["linear", "linear"]);
  });
});
