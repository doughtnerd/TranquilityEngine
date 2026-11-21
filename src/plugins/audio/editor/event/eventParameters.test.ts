// The Event editor's audition values. The parameter list's edits, for this holder and the global one, are
// parameterList.test.ts (ADR 0304).
import { describe, expect, it } from "vitest";
import type { LabelledParameter, NumericParameter } from "../../../../engine/audio/eventFormat";
import { auditionValues } from "./eventParameters";

const speed: NumericParameter = { name: "Speed", min: 0, max: 10, default: 2, seekSpeed: 5 };
const surface: LabelledParameter = { name: "Surface", labels: ["Grass", "Stone"], default: "Stone" };

describe("eventParameters", () => {
  it("auditionValues keeps valid values and falls back to defaults", () => {
    expect(auditionValues([speed, surface], { Speed: 4, Surface: "Grass", Gone: 1 })).toEqual({ Speed: 4, Surface: "Grass" });
    expect(auditionValues([speed, surface], { Speed: 40, Surface: "Mud" })).toEqual({ Speed: 2, Surface: "Stone" });
  });
});
