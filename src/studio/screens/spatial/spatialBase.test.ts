// ADR 0333: the base game scene's layer on the Spatial screen's plan: shapes and labels for each imported object, their
// height spans, Fit framing them, and the banner (which scene is underneath, or that it is missing).
import { describe, expect, it } from "vitest";
import { baseBanner, baseFramePoints, basePlanItems } from "./baseLayer";
import { FIXTURE_BASE_PATH, fixtureBase } from "./spatialFixture";

describe("the base scene's plan layer", () => {
  it("draws boxes, circles and points with labels, biggest shapes first", () => {
    const items = basePlanItems(fixtureBase());
    expect(items.map((i) => [i.kind, i.label, i.shape.kind])).toEqual([
      ["reverbZone", "Courtyard · room", "circle"],
      ["audioZone", "Fountain", "box"],
      ["collider", "North wall · stone", "box"],
      ["collider", "Pillar · stone", "circle"],
      ["emitter", "Well", "point"],
    ]);
    const wall = items.find((i) => i.label.startsWith("North wall"))!;
    expect(wall.shape.kind === "box" && wall.shape.corners).toEqual([{ x: 34, z: 35.5 }, { x: 46, z: 35.5 }, { x: 46, z: 36.5 }, { x: 34, z: 36.5 }]);
    expect([wall.low, wall.high]).toEqual([0, 5]);
    const pillar = items.find((i) => i.label.startsWith("Pillar"))!;
    expect(pillar.shape).toEqual({ kind: "circle", center: { x: 36, z: 30 }, radius: 0.8 });
    expect(basePlanItems(null)).toEqual([]);
  });

  it("frames the base's objects for Fit", () => {
    const pts = baseFramePoints(fixtureBase());
    expect(Math.min(...pts.map((p) => p.x))).toBe(8); // the fountain's west edge
    expect(Math.max(...pts.map((p) => p.x))).toBe(58); // the well
    expect(baseFramePoints(null)).toEqual([]);
  });

  it("says which game scene is underneath, or that it's missing", () => {
    expect(baseBanner(null)).toBeNull();
    expect(baseBanner(fixtureBase())).toEqual({ text: "Over canyon: 5 objects, read-only", warning: false });
    expect(baseBanner(fixtureBase(null))).toEqual({ text: "Base scene scenes/gone.scene.json is missing; playing without it", warning: true });
    expect(fixtureBase().path).toBe(FIXTURE_BASE_PATH);
  });
});
