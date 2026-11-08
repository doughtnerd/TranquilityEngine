// Polygon and edge collider handle math (ADR 0039), moved with the collider gizmo into the Physics editor half.
import { describe, expect, it } from "vitest";
import { insertPoint, movePoint, pointsHandle, pointsHandles, pointsOutline, readPoints, removePoint } from "./colliderMath";

describe("polygon and edge collider handles", () => {
  const identity = { position: [0, 0, 0] as const, rotation: 0, scale: [1, 1] as const };
  const square: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];

  it("has a vertex handle per point and an insert handle per edge (the closing edge only when closed)", () => {
    const closed = pointsHandles(identity, [1, 0], square, true);
    expect(closed["vertex:1"]).toEqual([3, 0, 0]); // offset by the centre
    expect(closed["insert:3"]).toEqual([1, 1, 0]); // the closing edge's middle
    expect(Object.keys(pointsHandles(identity, [0, 0], square, false)).filter((k) => k.startsWith("insert:"))).toHaveLength(3);
    expect(pointsOutline({ ...identity, scale: [2, 1] }, [0, 0], [[1, 1]])).toEqual([[2, 1, 0]]);
  });

  it("parses handle ids", () => {
    expect(pointsHandle("vertex:12")).toEqual({ kind: "vertex", index: 12 });
    expect(pointsHandle("insert:0")).toEqual({ kind: "insert", index: 0 });
    expect(pointsHandle("center")).toEqual({ kind: "center" });
    expect(pointsHandle("left")).toBeNull();
  });

  it("moves, inserts and removes points, keeping a minimum", () => {
    expect(movePoint(square, 2, [3, 3])[2]).toEqual([3, 3]);
    expect(insertPoint(square, 3)).toEqual([[0, 0], [2, 0], [2, 2], [0, 2], [0, 1]]);
    expect(insertPoint(square, 0)[1]).toEqual([1, 0]);
    expect(removePoint(square, 0, true)).toEqual([[2, 0], [2, 2], [0, 2]]);
    expect(removePoint(square.slice(0, 3), 0, true)).toBeNull();
    expect(removePoint(square.slice(0, 2), 0, false)).toBeNull();
    expect(readPoints([[1, 2], { x: 3, y: 4 }, ["a", 1], null])).toEqual([[1, 2], [3, 4]]);
  });
});
