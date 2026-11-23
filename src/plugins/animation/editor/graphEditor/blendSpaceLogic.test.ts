// The blend-space editor's model (T51): the preview's weights are the runtime's rule (`anim-graph`'s `triangulate.rs`
// and `space_weights`). The 2D cases are the Rust module's own tests, with the same inputs and the same expectations
// (tolerance 1e-5 or 1e-6 as there: the core computes in f32), plus hand-worked barycentric and 1D values; and sample
// edits keep inputs and coordinates together, refused-or-next.
import { describe, expect, it } from "vitest";
import { emptyAnimGraph, type AnimGraph } from "../../../../engine/animation/animGraph";
import { refusalOf, type EditResult } from "../../../../editor/sdk";
import { triangulate, weights1D, weights2D, type Point2 } from "./blendSpaceGeometry";
import { addSample, blendSamples, moveSample, previewWeights, removeSample } from "./blendSpaceLogic";
import { addNode, nodeById } from "./graphEditLogic";

const ok = <T>(r: EditResult<T>): T => {
  if ("refused" in r) throw new Error(`refused: ${r.refused}`);
  return r.next;
};
const orient = (a: Point2, b: Point2, c: Point2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const area = (pts: Point2[], tris: readonly (readonly number[])[]) => tris.reduce((s, t) => s + 0.5 * orient(pts[t[0]!]!, pts[t[1]!]!, pts[t[2]!]!), 0);

describe("the core's 2D rule (triangulate.rs's cases)", () => {
  it("a square is two triangles and four hull edges, deterministically", () => {
    const pts: Point2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const t = triangulate(pts);
    expect(t.triangles).toHaveLength(2);
    expect(t.hull).toHaveLength(4);
    expect(area(pts, t.triangles)).toBeCloseTo(1, 12);
    expect(triangulate(pts)).toEqual(t);
  });

  it("a 3×3 grid covers its hull with 8 triangles", () => {
    const pts: Point2[] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) pts.push([x - 1, y - 1]);
    const t = triangulate(pts);
    expect(t.triangles).toHaveLength(8);
    expect(t.hull).toHaveLength(8);
    expect(area(pts, t.triangles)).toBeCloseTo(4, 9);
  });

  it("duplicates and collinear points: a chain, weights by projection", () => {
    const pts: Point2[] = [[0, 0], [1, 0], [0, 0], [2, 0]];
    const t = triangulate(pts);
    expect(t.triangles).toEqual([]);
    expect(t.hull).toEqual([[0, 1], [1, 3]]);
    const w = weights2D(pts, t, [1.5, 3]);
    expect(w[1]).toBeCloseTo(0.5, 6);
    expect(w[3]).toBeCloseTo(0.5, 6);
    expect(triangulate([[0, 0], [1, 0], [2, 0], [1, 1]]).triangles).toHaveLength(2);
  });

  it("weights reproduce the vertices and interpolate linearly", () => {
    const pts: Point2[] = [[0, 0], [2, 0], [0, 2], [2, 2], [1, 1.2]];
    const t = triangulate(pts);
    pts.forEach((p, i) => expect(weights2D(pts, t, p)[i]).toBeCloseTo(1, 5));
    for (const q of [[0.3, 0.4], [1.5, 1.7], [1, 0.1]] as Point2[]) {
      const w = weights2D(pts, t, q);
      const s = w.reduce((acc, wi, i) => [acc[0]! + wi * pts[i]![0], acc[1]! + wi * pts[i]![1]], [0, 0]);
      expect(s[0]).toBeCloseTo(q[0], 5);
      expect(s[1]).toBeCloseTo(q[1], 5);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    }
  });

  it("outside points project onto the nearest hull edge; past a corner, the corner", () => {
    const pts: Point2[] = [[0, 0], [2, 0], [0, 2]];
    const t = triangulate(pts);
    const w = weights2D(pts, t, [0.5, -3]);
    expect(w[0]).toBeCloseTo(0.75, 6);
    expect(w[1]).toBeCloseTo(0.25, 6);
    expect(w[2]).toBe(0);
    expect(weights2D(pts, t, [5, -1])[1]).toBeCloseTo(1, 6);
  });

  it("one point takes all the weight", () => {
    const pts: Point2[] = [[3, 4]];
    const t = triangulate(pts);
    expect(t).toEqual({ triangles: [], hull: [] });
    expect(weights2D(pts, t, [0, 0])).toEqual([1]);
  });
});

describe("the core's 1D rule", () => {
  it("is linear between sorted neighbours, the end sample alone outside", () => {
    // Samples given out of order: walk at 1.5, idle at 0, run at 4.
    const xs = [1.5, 0, 4];
    expect(weights1D(xs, -1)).toEqual([0, 1, 0]);
    expect(weights1D(xs, 0.75)).toEqual([0.5, 0.5, 0]);
    const w = weights1D(xs, 2.75);
    expect(w[0]).toBeCloseTo(0.5, 6);
    expect(w[2]).toBeCloseTo(0.5, 6);
    expect(weights1D(xs, 4)).toEqual([0, 0, 1]);
    expect(weights1D(xs, 9)).toEqual([0, 0, 1]);
  });
});

describe("blend-space samples (T51)", () => {
  function space(kind: "blendSpace1D" | "blendSpace2D"): AnimGraph {
    let g = ok(addNode(emptyAnimGraph(), "sources", kind, [0, 0])).graph;
    for (const c of ["idle", "walk", "run"]) g = ok(addNode(g, "sources", "clipPlayer", [0, 0], { clip: `asset:clips/${c}.anim.json` })).graph;
    return g;
  }

  it("adds, moves and removes 2D samples with their coordinates; the preview is the runtime's weights", () => {
    let g = space("blendSpace2D");
    g = ok(addSample(g, "blendSpace2D", "clipPlayer", 0, 0));
    g = ok(addSample(g, "blendSpace2D", "clipPlayer2", 2, 0));
    g = ok(addSample(g, "blendSpace2D", "clipPlayer3", 0, 2));
    const node = nodeById(g, "blendSpace2D")!;
    expect(node.params.coords).toEqual([0, 0, 2, 0, 0, 2]);
    const samples = blendSamples(g, node);
    const w = previewWeights(node, samples, [0.5, 0.5]);
    expect(w[0]).toBeCloseTo(0.5, 6);
    expect(w[1]).toBeCloseTo(0.25, 6);
    expect(w[2]).toBeCloseTo(0.25, 6);
    expect(refusalOf(moveSample(g, "blendSpace2D", 2, 2, 0))).toMatch(/already at \(2, 0\)/);
    g = ok(moveSample(g, "blendSpace2D", 2, 1, 2));
    g = ok(removeSample(g, "blendSpace2D", 0));
    expect(nodeById(g, "blendSpace2D")!.params.coords).toEqual([2, 0, 1, 2]);
    expect(nodeById(g, "blendSpace2D")!.inputs).toEqual(["clipPlayer2", "clipPlayer3"]);
  });

  it("previews a 1D space by the 1D rule", () => {
    let g = space("blendSpace1D");
    g = ok(addSample(g, "blendSpace1D", "clipPlayer", 0));
    g = ok(addSample(g, "blendSpace1D", "clipPlayer2", 1.5));
    g = ok(addSample(g, "blendSpace1D", "clipPlayer3", 4));
    const node = nodeById(g, "blendSpace1D")!;
    expect(previewWeights(node, blendSamples(g, node), [0.75, 0])).toEqual([0.5, 0.5, 0]);
    expect(refusalOf(addSample(g, "blendSpace1D", "blendSpace1D", 2))).toMatch(/own input/);
  });
});
