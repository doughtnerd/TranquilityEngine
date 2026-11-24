// ADR 0382: ribbon geometry is pure, so it's tested on plain arrays.
import { describe, expect, it } from "vitest";
import { buildRibbon } from "./ribbon";

const pts = (...p: number[][]) => p.flat();
const widths = (n: number, hw = 0.5) => new Float32Array(n).fill(hw);

describe("ribbon geometry (ADR 0382)", () => {
  it("builds a ring of two vertices per point and two triangles between rings", () => {
    const r = buildRibbon({ points: pts([0, 0, 0], [1, 0, 0], [2, 0, 0]), halfWidths: widths(3), colors: null })!;
    expect(r.vertexCount).toBe(6);
    expect(r.indices.length).toBe(12);
    expect(r.colors).toBeNull();
  });

  it("drops repeated points and gives nothing with fewer than two distinct ones", () => {
    expect(buildRibbon({ points: pts([0, 0, 0], [0, 0, 0]), halfWidths: widths(2), colors: null })).toBeNull();
    const r = buildRibbon({ points: pts([0, 0, 0], [0, 0, 0], [1, 0, 0]), halfWidths: widths(3), colors: null })!;
    expect(r.vertexCount).toBe(4);
  });

  it("camera-facing: positions on the centre line, with tangents, sides, half widths and along-offsets", () => {
    const r = buildRibbon({ points: pts([0, 0, 0], [2, 0, 0]), halfWidths: new Float32Array([0.5, 0.25]), colors: null })!;
    expect(r.normals).toBeNull();
    expect(Array.from(r.positions)).toEqual([0, 0, 0, 0, 0, 0, 2, 0, 0, 2, 0, 0]);
    expect(Array.from(r.ribbon!.tangents.subarray(0, 8))).toEqual([1, 0, 0, -1, 1, 0, 0, 1]);
    expect(Array.from(r.ribbon!.extents)).toEqual([0.5, 0, 0.5, 0, 0.25, 0, 0.25, 0]);
  });

  it("flat: final positions across `normal × tangent`, with the normal per vertex", () => {
    const r = buildRibbon({ points: pts([0, 0, 0], [2, 0, 0]), halfWidths: widths(2), colors: null, normal: [0, 0, 1] })!;
    expect(r.ribbon).toBeNull();
    // z × x = y: the sides are at y = ∓0.5.
    expect(Array.from(r.positions.subarray(0, 6))).toEqual([0, -0.5, 0, 0, 0.5, 0]);
    expect(Array.from(r.normals!.subarray(0, 3))).toEqual([0, 0, 1]);
  });

  it("mitres a join so its edges meet, and cuts a sharp one back to the limit", () => {
    const right = buildRibbon({ points: pts([0, 0, 0], [1, 0, 0], [1, 1, 0]), halfWidths: widths(3), colors: null, normal: [0, 0, 1] })!;
    // The corner ring: along the bisector of +x and +y, widened by √2, so its outer vertex is the edges' corner.
    const outer = [right.positions[6]!, right.positions[7]!], inner = [right.positions[9]!, right.positions[10]!];
    expect(outer[0]).toBeCloseTo(1.5);
    expect(outer[1]).toBeCloseTo(-0.5);
    expect(inner[0]).toBeCloseTo(0.5);
    expect(inner[1]).toBeCloseTo(0.5);
    const back = buildRibbon({ points: pts([0, 0, 0], [1, 0, 0], [0, 0.01, 0]), halfWidths: widths(3), colors: null })!;
    expect(back.ribbon!.tangents[4 * 2 + 3]).toBeLessThanOrEqual(4);
  });

  it("rounds joins and ends with extra rings", () => {
    const r = buildRibbon({ points: pts([0, 0, 0], [1, 0, 0], [1, 1, 0]), halfWidths: widths(3), colors: null, cornerVertices: 3, capVertices: 2 })!;
    // start cap 2 + start ring 1, corner 1 + 3 + 1, end ring 1 + end cap 2 = 11 rings.
    expect(r.vertexCount).toBe(22);
    // The first cap ring is the tip: on the centre line, a half width back along the tangent.
    expect(r.ribbon!.tangents[3]).toBeCloseTo(0);
    expect(r.ribbon!.extents[1]).toBeCloseTo(-1);
    // The last is the other tip, a half width forward.
    expect(r.ribbon!.extents[21 * 2 + 1]).toBeCloseTo(1);
  });

  it("closes a loop with a join at every point and the texture wrapping once", () => {
    const r = buildRibbon({ points: pts([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]), closed: true, halfWidths: widths(4), colors: null, capVertices: 4 })!;
    expect(r.vertexCount).toBe(10); // four points and point 0 again; caps don't apply
    expect(r.uvs[0]).toBe(0);
    expect(r.uvs[8 * 2]).toBeCloseTo(1);
  });

  it("runs the texture by mode", () => {
    const p = pts([0, 0, 0], [1, 0, 0], [4, 0, 0]);
    const u = (mode: "stretch" | "tile" | "distributePerSegment" | "repeatPerSegment") =>
      Array.from(buildRibbon({ points: p, halfWidths: widths(3), colors: null, textureMode: mode, textureScale: [2, 3] })!.uvs).filter((_, i) => i % 4 === 0);
    expect(u("stretch")).toEqual([0, 0.5, 2]);
    expect(u("tile")).toEqual([0, 2, 8]);
    expect(u("distributePerSegment")).toEqual([0, 1, 2]);
    expect(u("repeatPerSegment")).toEqual([0, 2, 4]);
    const v = Array.from(buildRibbon({ points: p, halfWidths: widths(3), colors: null, textureScale: [1, 3] })!.uvs).filter((_, i) => i % 2 === 1);
    expect(v.slice(0, 2)).toEqual([0, 3]);
  });

  it("gives each vertex its point's colour, and shares indices between ribbons with as many rings", () => {
    const a = buildRibbon({ points: pts([0, 0, 0], [1, 0, 0]), halfWidths: widths(2), colors: [1, 0, 0, 1, 0, 0, 1, 0.5] })!;
    expect(Array.from(a.colors!)).toEqual([1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0.5, 0, 0, 1, 0.5]);
    const b = buildRibbon({ points: pts([5, 5, 5], [6, 6, 6]), halfWidths: widths(2), colors: null })!;
    expect(b.indices).toBe(a.indices);
  });
});
