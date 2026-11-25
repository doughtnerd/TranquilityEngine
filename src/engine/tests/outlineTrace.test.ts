import { describe, expect, it } from "vitest";
import { simplifyLoop, traceOutline } from "../render/sprites/outlineTrace";

// Outline tracing (ADR 0414): solid pixels' outlines in slice pixels (y up), holes dropped, simplified.

/** An alpha image from rows of text, top row first: `#` solid, `.` clear. */
function image(rows: string[]) {
  const height = rows.length, width = rows[0]!.length;
  const alpha = new Uint8Array(width * height);
  rows.forEach((r, y) => [...r].forEach((ch, x) => (alpha[y * width + x] = ch === "#" ? 255 : 0)));
  return { width, height, alpha };
}

const area = (p: [number, number][]) => p.reduce((a, [x, y], i) => a + x * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * y, 0) / 2;

describe("traceOutline", () => {
  it("traces a solid block as its rectangle, counter-clockwise, y up from the rect's bottom-left", () => {
    const img = image(["....", ".##.", ".##.", "...."]);
    const [loop, ...rest] = traceOutline(img, undefined, { minArea: 0 });
    expect(rest).toEqual([]);
    expect(loop!.length).toBe(4);
    expect(area(loop!)).toBe(4);
    expect(loop!).toEqual(expect.arrayContaining([[1, 1], [3, 1], [3, 3], [1, 3]]));
  });

  it("drops holes and specks, reads only the rect, and respects the threshold", () => {
    const ring = image(["#####", "#...#", "#...#", "#####", "....#"]);
    const loops = traceOutline(ring, [0, 0, 5, 4]);
    expect(loops).toHaveLength(1);
    expect(area(loops[0]!)).toBe(20);
    const faint = { width: 2, height: 2, alpha: new Uint8Array([10, 10, 10, 10]) };
    expect(traceOutline(faint, undefined, { threshold: 20, minArea: 0 })).toEqual([]);
    expect(traceOutline(faint, undefined, { threshold: 5, minArea: 0 })).toHaveLength(1);
  });

  it("simplifies a staircase within the tolerance", () => {
    const stairs = image(["#...", "##..", "###.", "####"]);
    const exact = traceOutline(stairs, undefined, { tolerance: 0 });
    const loose = traceOutline(stairs, undefined, { tolerance: 1 });
    expect(exact[0]!.length).toBe(10);
    expect(loose[0]!.length).toBeLessThan(exact[0]!.length);
    expect(simplifyLoop([[0, 0], [1, 0], [2, 0.1], [3, 0], [3, 3]], 0.5)).toHaveLength(3);
  });
});
