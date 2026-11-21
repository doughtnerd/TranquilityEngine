// The 3D shape kit (ADR 0295): its pose maths against the engine's own transforms, its wireframes against the sizes they
// draw, and the axis drag. Each shape table's entries (colliders, zones) are tested in their own plugin, over these.
import { describe, expect, it } from "vitest";
import { Engine, GameObject } from "../myco";
import { shapeKit3d } from "./sdk";

type Pose3D = shapeKit3d.Pose3D;
type V3 = shapeKit3d.V3;
const { axisDrag, blendHandle, blendPress, centerDelta, closestOnAxis, poseMatrix, pose3DOf, rotate, shellWire, sizedShapeWire, volumeWire, worldCenter } = shapeKit3d;

const close = (a: readonly number[], b: readonly number[], digits = 6) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));
};
const identity: Pose3D = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const turnY90: Pose3D["rotation"] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

describe("pose maths", () => {
  it("turns vectors by quaternions", () => {
    close(rotate(turnY90, [1, 0, 0]), [0, 0, -1]);
    close(rotate(turnY90, [0, 0, 1]), [1, 0, 0]);
  });

  it("finds where a ray passes closest to a handle's axis, and moves centres in local units", () => {
    // A ray straight down at x = 2 passes the x axis at 2.
    expect(closestOnAxis([2, 5, 0], [0, -1, 0], [0, 0, 0], [1, 0, 0])).toBeCloseTo(2);
    expect(closestOnAxis([0, 5, 0], [1, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNull(); // parallel
    close(centerDelta({ ...identity, rotation: turnY90, scale: [2, 1, 1] }, [0, 0, -2]), [1, 0, 0]);
  });

  it("reads a node's pose, and gives it back as the node's own world matrix; a shape's centre is that matrix applied", async () => {
    const engine = await Engine.create({ headless: true });
    try {
      const node = GameObject.create("posed");
      const t = node.transform!;
      t.position.set(1, -2, 3);
      t.scale.set(2, -0.5, 1.5); // one axis mirrored
      t.eulerAngles = { x: 0.4, y: -1.1, z: 2.0 };
      const pose = pose3DOf(node), m = t.localToWorld;
      close(poseMatrix(pose), [...m.value], 4);
      close(worldCenter(pose, [0.5, 1, -2]), [...m.transformPoint({ x: 0.5, y: 1, z: -2 }).toArray()], 4);
    } finally {
      engine.dispose();
    }
  });
});

describe("wireframes", () => {
  const box: shapeKit3d.Volume3D = { shape: "box", center: [1, 2, 3], axes: [[0, 0, -1], [0, 1, 0], [1, 0, 0]], half: [2, 1, 3], radius: 0 };

  it("draws a box's twelve edges between its corners and a sphere's three great circles", () => {
    const wire = volumeWire(box);
    expect(wire).toHaveLength(12);
    for (const p of wire.flat()) expect(dist(p, box.center)).toBeCloseTo(Math.hypot(2, 1, 3), 9);
    const sphere = volumeWire({ ...box, shape: "sphere", half: [0, 0, 0], radius: 4 });
    expect(sphere).toHaveLength(3);
    for (const p of sphere.flat()) expect(dist(p, box.center)).toBeCloseTo(4, 9);
  });

  it("draws the blend shell d outside the volume, nothing on a hard edge, and the blend handle on it", () => {
    for (const g of [box, { ...box, shape: "sphere" as const, half: [0, 0, 0] as V3, radius: 4 }]) {
      const d = 1.5;
      for (const p of shellWire(g, d).flat()) {
        // Distance outside: past each half extent along the axes (box) or past the radius (sphere).
        const local = g.axes.map((a) => (p[0] - g.center[0]) * a[0] + (p[1] - g.center[1]) * a[1] + (p[2] - g.center[2]) * a[2]);
        const outside = g.shape === "sphere" ? dist(p, g.center) - g.radius : Math.hypot(...local.map((v, i) => Math.max(Math.abs(v) - g.half[i]!, 0)));
        expect(outside).toBeCloseTo(d, 9);
      }
      expect(shellWire(g, 0)).toEqual([]);
      // The blend handle sits on the shell, and pressing it where it is gives back d.
      const handle = blendHandle(g, d), { direction } = shapeKit3d.blendAxis(g);
      const reach = (handle[0] - g.center[0]) * direction[0] + (handle[1] - g.center[1]) * direction[1] + (handle[2] - g.center[2]) * direction[2];
      expect((blendPress(g)(reach) as { blendDistance: number }).blendDistance).toBeCloseTo(d, 9);
    }
  });

  it("draws shapes at the sizes shape3d gives them: a capsule's rings, sides and caps reach its ends", () => {
    const pose: Pose3D = { position: [0, 0, 0], rotation: turnY90, scale: [1, 1, 1] };
    const capsule = sizedShapeWire({ kind: "capsule", radius: 0.5, halfHeight: 1, axis: 0 }, pose, [0, 0, 0]);
    expect(capsule).toHaveLength(10); // two rings, four sides, four caps
    const zs = capsule.flat().map((p) => p[2]); // local x is world -z
    close([Math.min(...zs), Math.max(...zs)], [-1.5, 1.5]);
    expect(sizedShapeWire({ kind: "box", halfExtents: [1, 1, 1] }, identity, [0, 0, 0])).toHaveLength(12);
  });
});

describe("the axis drag", () => {
  // A box face and the blend handle, as an entry built from the kit's rules would give them.
  const shape: shapeKit3d.HandleShape3D<{ center: V3; size: V3; blendDistance: number }> = {
    wire: () => [],
    handles: (f, pose) => {
      const g: shapeKit3d.Volume3D = { shape: "box", center: worldCenter(pose, f.center), axes: shapeKit3d.axesOf(pose), half: [f.size[0] / 2, f.size[1] / 2, f.size[2] / 2], radius: 0 };
      return { ...shapeKit3d.faceHandles(g), blend: blendHandle(g, f.blendDistance) };
    },
    handleAxis: (f, pose, handle) => (handle === "blend" ? shapeKit3d.blendAxis({ shape: "box", center: worldCenter(pose, f.center), axes: shapeKit3d.axesOf(pose), half: [f.size[0] / 2, f.size[1] / 2, f.size[2] / 2], radius: 0 }).direction : undefined),
    press: (f, pose, handle) => (handle === "blend" ? blendPress({ shape: "box", center: worldCenter(pose, f.center), axes: shapeKit3d.axesOf(pose), half: [f.size[0] / 2, f.size[1] / 2, f.size[2] / 2], radius: 0 }) : shapeKit3d.facePress(f, pose, handle)),
  };
  const f = { center: [0, 0, 0] as V3, size: [4, 2, 2] as V3, blendDistance: 1 };
  const down = (x: number, y: number) => ({ origin: [x, y, 10], direction: [0, 0, -1] }); // a camera looking down -z

  it("follows the pointer from where the press was, without jumping to it", () => {
    // Pressed half a unit inside the x+ face (at x = 2), moved to x = 4: the face moves 2 out, to x = 4.5 less the half.
    const drag = axisDrag(shape, f, identity, "x+", down(1.5, 0))!;
    expect(drag(down(3.5, 0), false)).toEqual({ size: [6, 2, 2], center: [1, 0, 0] });
    expect(drag(down(3.5, 0), true)).toEqual({ size: [8, 2, 2] }); // Alt: both faces
    expect(drag(null, false)).toBeNull();
  });

  it("moves the blend handle along its own axis, even off the centre's lines", () => {
    const at = shape.handles(f, identity).blend!;
    const drag = axisDrag(shape, f, identity, "blend", down(at[0], at[1]))!;
    const k = 2 * Math.SQRT1_2;
    expect((drag(down(at[0] + k, at[1] + k), false) as { blendDistance: number }).blendDistance).toBeCloseTo(3, 9);
  });

  it("does nothing for a handle the entry ignores, or one whose axis the press ray runs along", () => {
    expect(axisDrag(shape, f, identity, "nowhere", down(0, 0))).toBeNull();
    expect(axisDrag(shape, f, identity, "z+", down(0, 0))).toBeNull(); // the ray runs along z
  });
});
