// The Meshes plugin's occlusion read-outs (ADR 0460 §6): the Inspector's role badge words and the Occlusion table.
import { describe, expect, it } from "vitest";
import { effectiveOcclusionRole } from "../../../engine/render/visibility/occlusion/role";
import { occlusionOf, occlusionRows, occlusionRoleText } from "./occlusionLogic";

describe("occlusionRoleText", () => {
  const solid = { geometry: true, opaque: true, widthPx: 50 };
  it("words each effective role, with the reason an occluder only gets tested", () => {
    expect(occlusionRoleText(effectiveOcclusionRole("auto", solid)).label).toBe("Occluder + occludee");
    expect(occlusionRoleText(effectiveOcclusionRole("none", solid)).label).toBe("Never culled");
    expect(occlusionRoleText(effectiveOcclusionRole("occludee", solid))).toEqual({ label: "Occludee only", title: "Hidden when something covers it; it hides nothing." });
    expect(occlusionRoleText(effectiveOcclusionRole("auto", { ...solid, geometry: false })).title).toMatch(/no occluder geometry/);
    expect(occlusionRoleText(effectiveOcclusionRole("auto", { ...solid, opaque: false })).title).toMatch(/isn't opaque/);
    expect(occlusionRoleText(effectiveOcclusionRole("auto", { ...solid, widthPx: 1 })).title).toMatch(/too narrow on screen/);
    expect(occlusionRoleText(effectiveOcclusionRole("auto", { ...solid, skinned: true })).title).toMatch(/skinned/);
  });
});

describe("the Occlusion table", () => {
  it("reads the meshes feature's occlusion diagnostics, or nothing without them", () => {
    expect(occlusionOf(undefined)).toBeNull();
    expect(occlusionOf({ lod: {} })).toBeNull();
    expect(occlusionOf({ occlusion: { views: 1, occluders: 2, triangles: 24, tested: 10, culled: 4, ms: 0.5 } })).toEqual({ views: 1, occluders: 2, triangles: 24, tested: 10, culled: 4, ms: 0.5 });
    expect(occlusionOf({ occlusion: { views: "x" } })).toEqual({ views: 0, occluders: 0, triangles: 0, tested: 0, culled: 0, ms: 0 });
  });

  it("shows views, occluders with their triangles, tested, culled with its share, and time", () => {
    expect(occlusionRows({ views: 1, occluders: 2, triangles: 2400, tested: 10, culled: 4, ms: 0.456 })).toEqual([
      { label: "Views", value: "1" },
      { label: "Occluders", value: "2", detail: "2,400 triangles" },
      { label: "Tested", value: "10" },
      { label: "Culled", value: "4", detail: "40 % of tested" },
      { label: "Time", value: "0.46 ms" },
    ]);
    expect(occlusionRows({ views: 1, occluders: 0, triangles: 0, tested: 0, culled: 0, ms: 0 })[3]).toEqual({ label: "Culled", value: "0" });
  });
});
