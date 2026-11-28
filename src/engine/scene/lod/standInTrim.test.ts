// ADR 0460 §3: import-time hole trimming of occluder stand-ins, driven through `loadStandInTrimmer` (the occlusion core's
// editor module, loaded from disk in Node).
import { describe, expect, it } from "vitest";
import { loadStandInTrimmer } from "./standInTrim";

const NONE = 0xffffffff;

/**
 * A flat N×N grid on [0, 1]² (z = 0), two triangles per cell, with `skip(x, y)` cells left out. Returns the shared
 * positions and the triangles.
 */
function grid(n: number, skip: (x: number, y: number) => boolean): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) positions.push(x / n, y / n, 0);
  const indices: number[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (skip(x, y)) continue;
    const i = y * (n + 1) + x;
    indices.push(i, i + 1, i + n + 1, i + 1, i + n + 2, i + n + 1);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Every neighbour of a neighbour points back. */
function expectConsistentNeighbors(neighbors: Uint32Array, triangles: number): void {
  expect(neighbors.length).toBe(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    for (let k = 0; k < 3; k++) {
      const n = neighbors[t * 3 + k];
      if (n === NONE) continue;
      expect(n).toBeLessThan(triangles);
      expect(n).not.toBe(t);
      expect([neighbors[n * 3], neighbors[n * 3 + 1], neighbors[n * 3 + 2]]).toContain(t);
    }
  }
}

describe("stand-in hole trimming (ADR 0460 §3)", () => {
  // A wall with a doorway (cells 8..11 × 0..7 of 20: 0.2 wide, 0.4 high, far wider than 0.5 % of the diagonal).
  const N = 20;
  const door = (x: number, y: number) => x >= 8 && x < 12 && y < 8;
  const wall = grid(N, door);

  it("drops the triangles that close a doorway and keeps the rest with their own errors and neighbours", async () => {
    const trim = await loadStandInTrimmer();
    // The stand-in closes the doorway: the full grid over the same positions.
    const closed = grid(N, () => false);
    const result = trim(wall.positions, wall.indices, closed.indices);
    const doorTriangles = 4 * 8 * 2;
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.dropped).toBeLessThanOrEqual(doorTriangles);
    const kept = result.indices.length / 3;
    expect(kept).toBe(closed.indices.length / 3 - result.dropped);
    // No kept triangle lies inside the doorway, away from its frame.
    for (let t = 0; t < kept; t++) {
      let cx = 0, cy = 0;
      for (let k = 0; k < 3; k++) (cx += wall.positions[result.indices[t * 3 + k] * 3] / 3), (cy += wall.positions[result.indices[t * 3 + k] * 3 + 1] / 3);
      const inside = cx > 0.4 + 0.02 && cx < 0.6 - 0.02 && cy < 0.4 - 0.02;
      expect(inside).toBe(false);
    }
    expect(result.triangleErrors.length).toBe(kept);
    for (const e of result.triangleErrors) expect(e).toBeLessThanOrEqual(0.005);
    expect(result.maxError).toBeLessThanOrEqual(0.005);
    expectConsistentNeighbors(result.neighbors, kept);
    // The doorway's edges are boundaries of the kept triangles again.
    expect(Array.from(result.neighbors).filter((n) => n === NONE).length).toBeGreaterThan(4 * N);
  });

  it("keeps an exact stand-in whole, with zero errors", async () => {
    const trim = await loadStandInTrimmer();
    const result = trim(wall.positions, wall.indices, wall.indices);
    expect(result.dropped).toBe(0);
    expect(Array.from(result.indices)).toEqual(Array.from(wall.indices));
    for (const e of result.triangleErrors) expect(e).toBeLessThan(1e-5);
    expectConsistentNeighbors(result.neighbors, wall.indices.length / 3);
  });
});
