import { describe, expect, it } from "vitest";
import { FLIP_DIAGONAL, FLIP_X, FLIP_Y } from "./format";
import { TURN_CLOCKWISE, compose, flipPoint, inverse, rotateClockwise, sourceCorner } from "./tileFlips";

const ALL = Array.from({ length: 8 }, (_, i) => (i & 1 ? FLIP_X : 0) | (i & 2 ? FLIP_Y : 0) | (i & 4 ? FLIP_DIAGONAL : 0));
/** Points in cell units with distinct coordinates, so no two orientations act alike on all of them. */
const POINTS: [number, number][] = [[0.25, 0.5], [0.75, 0.125], [0.5, 0.5]];

describe("tile orientation algebra (ADR 0103)", () => {
  it("has 8 distinct orientations", () => {
    const keys = new Set(ALL.map((f) => POINTS.map(([x, y]) => flipPoint(x, y, f).join()).join(";")));
    expect(keys.size).toBe(8);
  });

  it("composes as applying the first, then the second, over all 8 x 8", () => {
    for (const a of ALL) for (const b of ALL) for (const [x, y] of POINTS) {
      const [mx, my] = flipPoint(x, y, a);
      expect(flipPoint(x, y, compose(a, b))).toEqual(flipPoint(mx, my, b));
    }
  });

  it("stays within the 8 orientations", () => {
    for (const a of ALL) for (const b of ALL) expect(ALL).toContain(compose(a, b));
  });

  it("has 0 as its identity on both sides", () => {
    for (const a of ALL) {
      expect(compose(a, 0)).toBe(a);
      expect(compose(0, a)).toBe(a);
    }
    for (const [x, y] of POINTS) expect(flipPoint(x, y, 0)).toEqual([x, y]);
  });

  it("is associative over all 8 x 8 x 8", () => {
    for (const a of ALL) for (const b of ALL) for (const c of ALL) {
      expect(compose(compose(a, b), c)).toBe(compose(a, compose(b, c)));
    }
  });

  it("is not commutative (a turn then a mirror differs from the reverse)", () => {
    expect(compose(TURN_CLOCKWISE, FLIP_X)).not.toBe(compose(FLIP_X, TURN_CLOCKWISE));
  });

  it("inverts on both sides, and the inverse undoes a point's mapping", () => {
    for (const a of ALL) {
      expect(compose(a, inverse(a))).toBe(0);
      expect(compose(inverse(a), a)).toBe(0);
      expect(inverse(inverse(a))).toBe(a);
      for (const [x, y] of POINTS) {
        const [mx, my] = flipPoint(x, y, a);
        const [bx, by] = flipPoint(mx, my, inverse(a));
        expect(bx).toBeCloseTo(x, 12);
        expect(by).toBeCloseTo(y, 12);
      }
    }
  });

  it("sourceCorner is the inverse mapping, in image space (t down)", () => {
    for (const a of ALL) for (const [s, t] of POINTS) {
      // flipPoint works with y up, so convert t <-> y around it.
      const [px, py] = flipPoint(s, 1 - t, inverse(a));
      const [cs, ct] = sourceCorner(s, t, a);
      expect(cs).toBeCloseTo(px, 12);
      expect(ct).toBeCloseTo(1 - py, 12);
    }
  });

  it("matches Tiled: the clockwise quarter turn is diagonal + horizontal", () => {
    expect(TURN_CLOCKWISE).toBe(FLIP_DIAGONAL | FLIP_X);
    // Corners of the cell (y up): top-left, top-right, bottom-right, bottom-left.
    const corners: [number, number][] = [[0, 1], [1, 1], [1, 0], [0, 0]];
    expect(corners.map(([x, y]) => flipPoint(x, y, TURN_CLOCKWISE))).toEqual([[1, 1], [1, 0], [0, 0], [0, 1]]); // each corner moves to the next clockwise
    // Tiled's 180 and 270 turns: horizontal + vertical, diagonal + vertical.
    expect(compose(TURN_CLOCKWISE, TURN_CLOCKWISE)).toBe(FLIP_X | FLIP_Y);
    expect(compose(compose(TURN_CLOCKWISE, TURN_CLOCKWISE), TURN_CLOCKWISE)).toBe(FLIP_DIAGONAL | FLIP_Y);
    // Single flags: X mirrors left-right, Y top-bottom, the diagonal swaps the axes.
    expect(flipPoint(0, 1, FLIP_X)).toEqual([1, 1]);
    expect(flipPoint(0, 1, FLIP_Y)).toEqual([0, 0]);
    expect(flipPoint(0, 1, FLIP_DIAGONAL)).toEqual([0, 1]); // top-left is on the axis
    expect(flipPoint(1, 1, FLIP_DIAGONAL)).toEqual([0, 0]); // top-right goes to bottom-left
    // The diagonal comes first: D|X is the swap followed by the mirror, not the reverse.
    expect(flipPoint(0, 1, FLIP_DIAGONAL | FLIP_X)).toEqual([1, 1]); // the mirror first would give [0, 0]
  });

  it("rotateClockwise cycles through four orientations from any start", () => {
    for (const a of ALL) {
      let f = a;
      const seen = new Set<number>();
      for (let i = 0; i < 4; i++) { seen.add(f); f = rotateClockwise(f); }
      expect(f).toBe(a);
      expect(seen.size).toBe(4);
    }
  });
});
