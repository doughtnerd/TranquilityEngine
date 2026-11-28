// The effective occlusion role (ADR 0460 §3, §6): every `occlusion` value, and each reason an occluder only gets tested.
import { describe, expect, it } from "vitest";
import { effectiveOcclusionRole, MIN_OCCLUDER_PIXELS, type OcclusionRoleFacts } from "./role";

const SOLID: OcclusionRoleFacts = { geometry: true, opaque: true, widthPx: 40 };

describe("effectiveOcclusionRole", () => {
  it("auto occludes and is tested when it has geometry, an opaque material and passes the width test", () => {
    expect(effectiveOcclusionRole("auto", SOLID)).toEqual({ occluder: true, occludee: true, reason: null });
    expect(effectiveOcclusionRole("auto", { ...SOLID, widthPx: null })).toEqual({ occluder: true, occludee: true, reason: null }); // no view yet: passes
    expect(effectiveOcclusionRole("auto", { ...SOLID, widthPx: MIN_OCCLUDER_PIXELS })).toMatchObject({ occluder: true });
  });

  it("gives the reason auto is an occludee only: no geometry, transparent, too narrow, skinned (in that order)", () => {
    expect(effectiveOcclusionRole("auto", { ...SOLID, geometry: false, opaque: false })).toEqual({ occluder: false, occludee: true, reason: "noGeometry" });
    expect(effectiveOcclusionRole("auto", { ...SOLID, opaque: false, widthPx: 1 })).toEqual({ occluder: false, occludee: true, reason: "transparent" });
    expect(effectiveOcclusionRole("auto", { ...SOLID, widthPx: MIN_OCCLUDER_PIXELS - 0.01 })).toEqual({ occluder: false, occludee: true, reason: "narrow" });
    expect(effectiveOcclusionRole("auto", { ...SOLID, skinned: true })).toEqual({ occluder: false, occludee: true, reason: "skinned" });
  });

  it("occluder skips the width test but still needs geometry and an opaque material", () => {
    expect(effectiveOcclusionRole("occluder", { ...SOLID, widthPx: 0.1 })).toEqual({ occluder: true, occludee: true, reason: null });
    expect(effectiveOcclusionRole("occluder", { ...SOLID, geometry: false })).toMatchObject({ occluder: false, reason: "noGeometry" });
    expect(effectiveOcclusionRole("occluder", { ...SOLID, opaque: false })).toMatchObject({ occluder: false, reason: "transparent" });
  });

  it("occludee is only tested and none is neither, whatever the facts", () => {
    expect(effectiveOcclusionRole("occludee", SOLID)).toEqual({ occluder: false, occludee: true, reason: null });
    expect(effectiveOcclusionRole("none", SOLID)).toEqual({ occluder: false, occludee: false, reason: null });
    expect(effectiveOcclusionRole("none", { ...SOLID, skinned: true })).toEqual({ occluder: false, occludee: false, reason: null });
  });
});
