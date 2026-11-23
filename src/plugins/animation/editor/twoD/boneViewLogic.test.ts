// The bone editor view's geometry and rows (ADR 0373; T56): stage and slice-frame points round trip, a press starts the gesture
// its tool and target say, the bone list reads as a tree and the wireframe has each edge once.
import { describe, expect, it } from "vitest";
import type { SliceSkin } from "../../../../engine/animation/sprites/sidecar";
import { boneRows, defaultZoom, gestureFor, meshEdges, sliceToStage, stageToSlice, weightOnBone } from "./boneViewLogic";

const RECT = [8, 4, 40, 20] as const;

describe("stage and slice-frame points", () => {
  it("y flips: the stage's top is the slice's top edge", () => {
    expect(sliceToStage(RECT, 4, 0, 20)).toEqual([0, 0]);
    expect(sliceToStage(RECT, 4, 40, 0)).toEqual([160, 80]);
    expect(stageToSlice(RECT, 4, 160, 80)).toEqual([40, 0]);
  });

  it("round trips at any zoom", () => {
    for (const zoom of [1, 3, 12.5]) {
      const [sx, sy] = sliceToStage(RECT, zoom, 13.25, 7.5);
      const [x, y] = stageToSlice(RECT, zoom, sx, sy);
      expect(x).toBeCloseTo(13.25, 9);
      expect(y).toBeCloseTo(7.5, 9);
    }
  });

  it("the default zoom is whole and fits the box", () => {
    expect(defaultZoom([0, 0, 40, 20])).toBe(10);
    expect(defaultZoom([0, 0, 4000, 20])).toBe(1);
    expect(defaultZoom([0, 0, 1, 1])).toBe(32);
  });
});

describe("gestures", () => {
  const none = { bone: null, end: null, vertex: null } as const;
  it("create always draws; move needs a bone and takes the tip handle or the rest as the head; mesh needs a vertex; paint paints", () => {
    expect(gestureFor("create", none)).toEqual({ kind: "create" });
    expect(gestureFor("move", none)).toEqual({ kind: "none" });
    expect(gestureFor("move", { bone: "a", end: "tip", vertex: null })).toEqual({ kind: "move-bone", bone: "a", end: "tip" });
    expect(gestureFor("move", { bone: "a", end: "body", vertex: null })).toEqual({ kind: "move-bone", bone: "a", end: "head" });
    expect(gestureFor("move", { bone: "a", end: "head", vertex: null })).toEqual({ kind: "move-bone", bone: "a", end: "head" });
    expect(gestureFor("mesh", none)).toEqual({ kind: "none" });
    expect(gestureFor("mesh", { bone: null, end: null, vertex: 3 })).toEqual({ kind: "move-vertex", vertex: 3 });
    expect(gestureFor("paint", none)).toEqual({ kind: "paint" });
  });
});

describe("the bone list and mesh drawing", () => {
  const bone = (name: string, parent: string | null) => ({ name, parent, position: [0, 0] as const, rotation: 0, length: 1 });
  it("lists parents before children, children in declared order, with depth", () => {
    const skin: SliceSkin = { bones: [bone("hand", "arm"), bone("hip", null), bone("arm", "hip"), bone("leg", "hip"), bone("orphan", "gone")], mesh: null, weights: null };
    expect(boneRows(skin)).toEqual([
      { name: "hip", depth: 0 },
      { name: "arm", depth: 1 },
      { name: "hand", depth: 2 },
      { name: "leg", depth: 1 },
      { name: "orphan", depth: 0 },
    ]);
  });

  it("reads a vertex's weight on a bone, 0 when it has none", () => {
    const weights = [[0, 0.25, 2, 0.75], []];
    expect(weightOnBone(weights, 0, 2)).toBe(0.75);
    expect(weightOnBone(weights, 0, 1)).toBe(0);
    expect(weightOnBone(weights, 1, 0)).toBe(0);
    expect(weightOnBone(weights, 5, 0)).toBe(0);
    expect(weightOnBone(null, 0, 0)).toBe(0);
  });

  it("each edge of the triangles once", () => {
    expect(meshEdges([0, 1, 2, 0, 2, 3])).toEqual([[0, 1], [1, 2], [0, 2], [2, 3], [0, 3]]);
    expect(meshEdges([])).toEqual([]);
  });
});
