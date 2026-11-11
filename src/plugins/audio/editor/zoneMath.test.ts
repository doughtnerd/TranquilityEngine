import { describe, expect, it } from "vitest";
import { makeZoneVolume, outsideDistance, zoneVolumeFromMatrix, ZONE_SHAPE_BOX, ZONE_SHAPE_SPHERE } from "../runtime/core/zoneWeights";
import {
  blendAxis,
  blendHandle,
  closestOnAxis,
  dragBlend,
  dragZoneFace,
  dragZoneRadius,
  MIN_EXTENT,
  rotate,
  zoneFaceHandles,
  zoneGeometry,
  zoneRadiusHandles,
  zoneShellWire,
  zoneVolumeWire,
  CIRCLE_SEGMENTS,
  SHELL_ARC_SEGMENTS,
  type Pose3D,
  type Quat,
  type V3,
} from "./zoneMath";

const close = (a: readonly number[], b: readonly number[], digits = 6) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));
};
const S = Math.SQRT1_2;
const Y90: Quat = [0, S, 0, S]; // 90 degrees about +Y: x -> -z, z -> +x

/** Column-major T·R·S, as the engine's world matrix (the convention of zoneWeights.ts). */
function matrixOf(pose: Pose3D): number[] {
  const [x, y, z] = [rotate(pose.rotation, [1, 0, 0]), rotate(pose.rotation, [0, 1, 0]), rotate(pose.rotation, [0, 0, 1])];
  const [sx, sy, sz] = pose.scale;
  return [x[0] * sx, x[1] * sx, x[2] * sx, 0, y[0] * sy, y[1] * sy, y[2] * sy, 0, z[0] * sz, z[1] * sz, z[2] * sz, 0, ...pose.position, 1];
}

// Case A: node at (10, 0, 0), scale (2, 1, 1); box centre (1, 0, 0), size (4, 2, 6).
//   world centre = (10 + 1 x 2, 0, 0) = (12, 0, 0); half extents = (4 x 2 / 2, 2 / 2, 6 / 2) = (4, 1, 3).
const poseA: Pose3D = { position: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 1, 1] };
const boxA = () => zoneGeometry(poseA, "box", [1, 0, 0], [4, 2, 6], 5);

describe("zone geometry (the sizes zoneVolumeFromMatrix gives)", () => {
  it("places a box's centre and half extents from the node's scale", () => {
    const g = boxA();
    expect(g.shape).toBe("box");
    expect(g.center).toEqual([12, 0, 0]);
    expect(g.half).toEqual([4, 1, 3]);
  });

  it("sizes a sphere by the largest scale axis: radius 5, scale (2, 1, 3) is 15", () => {
    const g = zoneGeometry({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 1, 3] }, "sphere", [0, 0, 0], [10, 4, 10], 5);
    expect(g.radius).toBe(15);
    expect(g.half).toEqual([0, 0, 0]);
  });

  it("turns the axes and the offset with the node: Y 90 degrees puts local x on -z", () => {
    const g = zoneGeometry({ position: [0, 0, 0], rotation: Y90, scale: [1, 1, 1] }, "box", [1, 0, 0], [4, 2, 6], 5);
    close(g.center, [0, 0, -1]);
    close(g.axes[0], [0, 0, -1]);
    close(g.axes[2], [1, 0, 0]);
  });

  it("counts negative sizes and radius as 0", () => {
    expect(zoneGeometry(poseA, "box", [0, 0, 0], [-4, 2, 6], 5).half).toEqual([0, 1, 3]);
    expect(zoneGeometry(poseA, "sphere", [0, 0, 0], [1, 1, 1], -3).radius).toBe(0);
  });

  it("agrees with zoneVolumeFromMatrix on centre, half extents and radius", () => {
    const pose: Pose3D = { position: [3, -2, 7], rotation: Y90, scale: [2, 0.5, 3] };
    const v = zoneVolumeFromMatrix(makeZoneVolume(), matrixOf(pose), 0, ZONE_SHAPE_BOX, 1, 2, 3, 4, 6, 8, 5);
    const g = zoneGeometry(pose, "box", [1, 2, 3], [4, 6, 8], 5);
    close(g.center, [v.cx, v.cy, v.cz]);
    close(g.half, [v.hx, v.hy, v.hz]);
    const s = zoneVolumeFromMatrix(makeZoneVolume(), matrixOf(pose), 0, ZONE_SHAPE_SPHERE, 1, 2, 3, 4, 6, 8, 5);
    expect(zoneGeometry(pose, "sphere", [1, 2, 3], [4, 6, 8], 5).radius).toBeCloseTo(s.radius, 9); // 5 x 3 = 15
  });
});

describe("wireframes", () => {
  it("draws a box as twelve edges between its corners", () => {
    const wire = zoneVolumeWire(boxA());
    expect(wire.length).toBe(12);
    expect(wire[0]).toEqual([[8, -1, -3], [16, -1, -3]]); // corner 0 to corner 1
    expect(wire[11]).toEqual([[16, 1, -3], [16, 1, 3]]); // corner 3 to corner 7
  });

  it("draws a sphere as three great circles of 15 world units", () => {
    const g = zoneGeometry({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 1, 3] }, "sphere", [0, 0, 0], [1, 1, 1], 5);
    const wire = zoneVolumeWire(g);
    expect(wire.length).toBe(3);
    wire.forEach((c) => {
      expect(c.length).toBe(CIRCLE_SEGMENTS + 1);
      c.forEach((p) => expect(Math.hypot(...p)).toBeCloseTo(15, 9));
    });
    close(wire[0]![0]!, [15, 0, 0]);
    close(wire[0]![CIRCLE_SEGMENTS / 4]!, [0, 15, 0]);
  });

  it("every volume point is on the surface and every shell point is blendDistance outside it (outsideDistance)", () => {
    const pose: Pose3D = { position: [3, -2, 7], rotation: Y90, scale: [2, 0.5, 3] };
    for (const shape of ["box", "sphere"] as const) {
      const g = zoneGeometry(pose, shape, [1, 2, 3], [4, 6, 8], 5);
      const v = zoneVolumeFromMatrix(makeZoneVolume(), matrixOf(pose), 0, shape === "box" ? ZONE_SHAPE_BOX : ZONE_SHAPE_SPHERE, 1, 2, 3, 4, 6, 8, 5);
      for (const line of zoneVolumeWire(g)) for (const p of line) expect(outsideDistance(v, p[0], p[1], p[2])).toBeCloseTo(0, 9);
      const shell = zoneShellWire(g, 2);
      expect(shell.length).toBe(3);
      for (const line of shell) for (const p of line) expect(outsideDistance(v, p[0], p[1], p[2])).toBeCloseTo(2, 9);
    }
  });

  it("draws a box's shell as three closed rounded rectangles (4 arcs of 8 segments, first point repeated)", () => {
    const shell = zoneShellWire(boxA(), 2);
    shell.forEach((loop) => {
      expect(loop.length).toBe(4 * (SHELL_ARC_SEGMENTS + 1) + 1);
      expect(loop[loop.length - 1]).toEqual(loop[0]);
    });
    close(shell[0]![0]!, [18, 1, 0]); // x-y plane: the +x +y corner arc starts straight out from the corner (16 + 2, 1)
    close(shell[0]![SHELL_ARC_SEGMENTS]!, [16, 3, 0]); // and ends straight up from it
  });

  it("draws a sphere's shell at radius + blendDistance, and no shell for a hard edge", () => {
    const g = zoneGeometry({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, "sphere", [0, 0, 0], [1, 1, 1], 5);
    close(zoneShellWire(g, 2)[0]![0]!, [7, 0, 0]);
    expect(zoneShellWire(g, 0)).toEqual([]);
    expect(zoneShellWire(boxA(), 0)).toEqual([]);
    expect(zoneShellWire(boxA(), -1)).toEqual([]);
  });
});

describe("handles", () => {
  it("puts a box's face handles at the face centres", () => {
    expect(zoneFaceHandles(boxA())).toEqual({ "x+": [16, 0, 0], "x-": [8, 0, 0], "y+": [12, 1, 0], "y-": [12, -1, 0], "z+": [12, 0, 3], "z-": [12, 0, -3] });
  });

  it("turns face handles with the node", () => {
    const g = zoneGeometry({ position: [0, 0, 0], rotation: Y90, scale: [1, 1, 1] }, "box", [1, 0, 0], [4, 2, 6], 5);
    const h = zoneFaceHandles(g);
    close(h["x+"], [0, 0, -3]); // centre (0, 0, -1) + 2 along -z
    close(h["z+"], [3, 0, -1]); // centre + 3 along +x
  });

  it("puts a sphere's radius handles on the rim", () => {
    const g = zoneGeometry({ position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [2, 1, 3] }, "sphere", [0, 0, 0], [1, 1, 1], 5);
    const h = zoneRadiusHandles(g);
    expect(h["radius:x+"]).toEqual([16, 2, 3]);
    expect(h["radius:x-"]).toEqual([-14, 2, 3]);
    expect(h["radius:y+"]).toEqual([1, 17, 3]);
    expect(h["radius:z-"]).toEqual([1, 2, -12]);
  });

  it("puts the blend handle blendDistance out of the box's +x +y edge along the diagonal", () => {
    const { origin, direction } = blendAxis(boxA());
    expect(origin).toEqual([16, 1, 0]);
    close(direction, [S, S, 0]);
    close(blendHandle(boxA(), 2), [16 + Math.SQRT2, 1 + Math.SQRT2, 0]); // (17.41421356, 2.41421356, 0)
    close(blendHandle(boxA(), 0), [16, 1, 0]);
    close(blendHandle(boxA(), -3), [16, 1, 0]);
  });

  it("puts the blend handle on the sphere's rim along the diagonal", () => {
    const g = zoneGeometry({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, "sphere", [0, 0, 0], [1, 1, 1], 5);
    close(blendHandle(g, 2), [7 * S, 7 * S, 0]);
  });

  it("every blend handle is blendDistance from the volume (outsideDistance) along the diagonal edge", () => {
    const g = boxA();
    const v = zoneVolumeFromMatrix(makeZoneVolume(), matrixOf(poseA), 0, ZONE_SHAPE_BOX, 1, 0, 0, 4, 2, 6, 5);
    const p = blendHandle(g, 2);
    expect(outsideDistance(v, p[0], p[1], p[2])).toBeCloseTo(2, 9);
  });
});

describe("drags", () => {
  const center: V3 = [1, 0, 0], size: V3 = [4, 2, 6];

  it("drags x+ out to 6 world units from the centre: the x- face stays at world 8", () => {
    // half is 4, so the box spans 8..16 now and 8..18 after: world size 10, size.x 10 / 2 = 5, centre.x 1 + (10 / 2 - 4) / 2 = 1.5.
    const r = dragZoneFace("x+", 6, poseA, center, size);
    expect(r.size).toEqual([5, 2, 6]);
    expect(r.center).toEqual([1.5, 0, 0]);
    // world: centre 10 + 1.5 x 2 = 13, half 5: faces at 8 and 18.
  });

  it("drags x- the same way on the other side", () => {
    // reach 6 on x-: spans 6..16 world? fixed face at 16, dragged to 12 - 6 = 6: world size 10, size.x 5, centre.x 1 - 0.5 = 0.5 (world 11, half 5: 6..16).
    const r = dragZoneFace("x-", 6, poseA, center, size);
    expect(r.size).toEqual([5, 2, 6]);
    expect(r.center).toEqual([0.5, 0, 0]);
  });

  it("moves both faces with Alt: size = 2 x reach / scale, centre unchanged", () => {
    const r = dragZoneFace("x+", 6, poseA, center, size, true);
    expect(r.size).toEqual([6, 2, 6]);
    expect(r.center).toEqual([1, 0, 0]);
  });

  it("never shrinks a face below the minimum", () => {
    const r = dragZoneFace("y+", -100, poseA, center, size);
    expect(r.size[1]).toBeCloseTo(MIN_EXTENT, 9);
    expect(r.center[1]).toBeCloseTo(-0.995, 9); // 0 + (0.005 - 1)
    expect(dragZoneFace("y+", 0, poseA, center, size, true).size[1]).toBe(MIN_EXTENT);
  });

  it("leaves the other axes alone", () => {
    const r = dragZoneFace("z-", 5, poseA, center, size);
    expect([r.size[0], r.size[1], r.center[0], r.center[1]]).toEqual([4, 2, 1, 0]);
    expect(r.size[2]).toBe(8); // 5 + half 3
    expect(r.center[2]).toBe(-1); // -(8 / 2 - 3)
  });

  it("turns a sphere handle into radius local units: 30 world / scale 3 = 10", () => {
    const pose: Pose3D = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 1, 3] };
    expect(dragZoneRadius(30, pose)).toBe(10);
    expect(dragZoneRadius(-30, pose)).toBe(10);
    expect(dragZoneRadius(0, pose)).toBe(MIN_EXTENT);
  });

  it("keeps the blend distance at or above 0", () => {
    expect(dragBlend(2.5)).toBe(2.5);
    expect(dragBlend(-1)).toBe(0);
  });

  it("finds the point on an axis nearest a ray", () => {
    // A ray straight down -z at x = 3 passes the x axis at x = 3; parallel rays give null.
    expect(closestOnAxis([3, 0, 50], [0, 0, -1], [0, 0, 0], [1, 0, 0])).toBeCloseTo(3, 9);
    expect(closestOnAxis([3, 0, 50], [1, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNull();
  });
});
