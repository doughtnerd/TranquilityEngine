import { describe, expect, it } from "vitest";
import { hitHandle, insidePolygon, pointHandles, pressPoints, type V2 } from "./polygonEdit";

describe("polygon point editing", () => {
  const tri: V2[] = [[0, 0], [2, 0], [1, 2]];

  it("adds a point mid-edge, removes one with Ctrl (not below three), and drags", () => {
    expect(pressPoints(tri, "insert:0", false)).toEqual({ drag: 1, points: [[0, 0], [1, 0], [2, 0], [1, 2]] });
    expect(pressPoints(tri, "insert:2", false)).toEqual({ drag: 3, points: [[0, 0], [2, 0], [1, 2], [0.5, 1]] });
    expect(pressPoints(tri, "p:1", true)).toEqual({ refused: "An outline needs at least 3 points." });
    expect(pressPoints([...tri, [0, 1]], "p:3", true)).toEqual({ removed: tri });
    expect(pressPoints(tri, "p:0", false)).toMatchObject({ drag: 0 });
    expect(pressPoints(tri, "p:9", false)).toBeNull();
    expect(pressPoints(tri, "nope", false)).toBeNull();
    // A line may go down to two points when the caller says so.
    expect(pressPoints(tri, "p:0", true, 2)).toEqual({ removed: [[2, 0], [1, 2]] });
  });

  it("doesn't change the points it's given", () => {
    const pts: V2[] = [[0, 0], [2, 0], [1, 2]];
    const r = pressPoints(pts, "insert:0", false) as { points: V2[] };
    r.points[0]![0] = 9;
    expect(pts).toEqual(tri);
  });

  it("has a handle per point and one per edge (open outlines skip the closing edge)", () => {
    expect(Object.keys(pointHandles(tri, false))).toEqual(["p:0", "p:1", "p:2", "insert:0", "insert:1"]);
    expect(pointHandles(tri, true)["insert:2"]).toEqual([0.5, 1]);
    expect(pointHandles([[1, 1]], true)).toEqual({ "p:0": [1, 1] });
  });

  it("hits the nearest handle in reach, a point before a mid-edge handle", () => {
    const h = pointHandles(tri, true);
    expect(hitHandle(h, [0.1, 0.1], 0.3)).toBe("p:0");
    expect(hitHandle(h, [1, 0.1], 0.3)).toBe("insert:0");
    expect(hitHandle(h, [1, 1], 0.3)).toBeNull();
    // Both a point and an insert handle in reach: the point wins even when the insert handle is nearer.
    expect(hitHandle({ "p:0": [0, 0], "insert:0": [0.2, 0] }, [0.15, 0], 0.5)).toBe("p:0");
  });

  it("tells inside from outside", () => {
    expect(insidePolygon(tri, [1, 0.5])).toBe(true);
    expect(insidePolygon(tri, [0.1, 1.5])).toBe(false);
    expect(insidePolygon(tri, [3, 0.5])).toBe(false);
  });
});
