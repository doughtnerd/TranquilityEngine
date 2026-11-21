// The zone shape table (ADR 0295), driven entry by entry like the collider shape table: property tests over random
// fields and poses ("dragging a handle to where it is leaves the zone unchanged"; "the outline is the runtime volume",
// measured with the zone manager's own `zoneVolumeFromMatrix` and `outsideDistance` on a real node's world matrix), then
// examples of each entry's rules.
import { describe, expect, it } from "vitest";
import { Engine, GameObject } from "../../../myco";
import { shapeKit3d } from "../../../editor/sdk";
import { makeZoneVolume, outsideDistance, zoneVolumeFromMatrix, ZONE_SHAPE_BOX, ZONE_SHAPE_SPHERE } from "../runtime/core/zoneWeights";
import { ZONE_SHAPES, zoneShapeFor, type ZoneFields, type ZoneShape } from "./zoneShapes";

type Pose3D = shapeKit3d.Pose3D;
type V3 = shapeKit3d.V3;
const { MIN_EXTENT, axisDrag, resizeAxis } = shapeKit3d;

const close = (a: readonly number[], b: readonly number[], digits = 6) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));
};
const S = Math.SQRT1_2;
const Y90: Pose3D["rotation"] = [0, S, 0, S]; // 90 degrees about +Y: x -> -z, z -> +x
const identity: Pose3D = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const fields = (f: Partial<ZoneFields> = {}): ZoneFields => ({ center: [0, 0, 0], size: [1, 1, 1], radius: 1, blendDistance: 0, ...f });
const apply = (f: ZoneFields, patch: shapeKit3d.FieldPatch): ZoneFields => ({ ...f, ...patch }) as ZoneFields;
const shapes = Object.values(ZONE_SHAPES) as ZoneShape[];

/** A small seeded random source, so a failing case can be replayed. */
function random(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const range = (lo: number, hi: number) => lo + (hi - lo) * next();
  /** A scale factor, sometimes negative (mirrored). */
  const scale = () => range(0.3, 2.5) * (next() < 0.2 ? -1 : 1);
  return { next, range, scale };
}
type Rnd = ReturnType<typeof random>;
const unitQuat = (r: Rnd): Pose3D["rotation"] => {
  const q = [r.range(-1, 1), r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)];
  const n = Math.hypot(...q) || 1;
  return q.map((v) => v / n) as Pose3D["rotation"];
};
const randomPose = (r: Rnd): Pose3D => ({ position: [r.range(-5, 5), r.range(-5, 5), r.range(-5, 5)], rotation: unitQuat(r), scale: [r.scale(), r.scale(), r.scale()] });
const randomFields = (r: Rnd): ZoneFields => ({
  center: [r.range(-2, 2), r.range(-2, 2), r.range(-2, 2)],
  size: [r.range(0.2, 6), r.range(0.2, 6), r.range(0.2, 6)],
  radius: r.range(0.2, 5),
  blendDistance: r.next() < 0.2 ? 0 : r.range(0.1, 3),
});

/** A ray that hits world point `at` square across the unit `axis`. */
function rayOnto(at: V3, axis: V3): shapeKit3d.Ray3D {
  const helper = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const n = [axis[1] * helper[2]! - axis[2] * helper[1]!, axis[2] * helper[0]! - axis[0] * helper[2]!, axis[0] * helper[1]! - axis[1] * helper[0]!];
  const len = Math.hypot(n[0]!, n[1]!, n[2]!);
  const d = n.map((v) => -v / len);
  return { origin: [at[0] - d[0]! * 5, at[1] - d[1]! * 5, at[2] - d[2]! * 5], direction: d };
}

describe("every entry of the zone shape table (ADR 0295)", () => {
  it("has a box zone and a sphere zone, found by the shape field as the zone manager reads it", () => {
    expect(shapes.map((s) => s.shape)).toEqual(["box", "sphere"]);
    expect(zoneShapeFor("sphere")).toBe(ZONE_SHAPES.sphere);
    expect(zoneShapeFor("box")).toBe(ZONE_SHAPES.box);
    expect(zoneShapeFor("anything else")).toBe(ZONE_SHAPES.box);
  });

  for (const shape of shapes) {
    it(`${shape.shape}: dragging any handle (blend included) to where it is leaves the volume and the shell unchanged, Alt or not`, () => {
      const r = random(shape.shape.length * 104729);
      for (let n = 0; n < 40; n++) {
        const f = randomFields(r), pose = randomPose(r);
        const wire = shape.wire(f, pose).flat().flat(), shell = shape.shell(f, pose).flat().flat();
        const handles = shape.handles(f, pose);
        expect(Object.keys(handles)).toContain("blend");
        for (const [id, at] of Object.entries(handles)) {
          const ray = rayOnto(at, resizeAxis(shape, f, pose, id)!);
          const drag = axisDrag(shape, f, pose, id, ray); // pressed on the handle, moved nowhere
          expect(drag, id).not.toBeNull();
          for (const alt of [false, true]) {
            const after = apply(f, drag!(ray, alt)!);
            close(shape.wire(after, pose).flat().flat(), wire);
            expect(after.blendDistance).toBeCloseTo(f.blendDistance, 9); // on a hard edge, float noise past 0 (the gizmo writes it tidied)
            if (f.blendDistance > 0) close(shape.shell(after, pose).flat().flat(), shell);
          }
        }
      }
    });
  }
});

describe("the outline is the runtime zone volume (ADR 0295)", () => {
  it("every outline point is on the volume the zone manager builds from the node's world matrix, every shell point blendDistance outside it", async () => {
    const engine = await Engine.create({ headless: true });
    try {
      const r = random(4242);
      for (let n = 0; n < 20; n++) {
        const node = GameObject.create("zone");
        const t = node.transform!;
        t.position.set(r.range(-5, 5), r.range(-5, 5), r.range(-5, 5));
        t.scale.set(r.scale(), r.scale(), r.scale());
        t.eulerAngles = { x: r.range(-1.5, 1.5), y: r.range(-Math.PI, Math.PI), z: r.range(-Math.PI, Math.PI) };
        const f = randomFields(r), pose = shapeKit3d.pose3DOf(node);
        for (const shape of shapes) {
          // As `zones.ts` sizes it: the node's world matrix (as the public `localToWorld` gives it), the zone's fields.
          const v = zoneVolumeFromMatrix(makeZoneVolume(), t.localToWorld.value, 0, shape.shape === "sphere" ? ZONE_SHAPE_SPHERE : ZONE_SHAPE_BOX, ...f.center, ...f.size, f.radius);
          for (const line of shape.wire(f, pose)) for (const p of line) expect(outsideDistance(v, p[0], p[1], p[2])).toBeCloseTo(0, 3);
          for (const line of shape.shell(f, pose)) for (const p of line) expect(outsideDistance(v, p[0], p[1], p[2])).toBeCloseTo(f.blendDistance, 3);
          const blend = shape.handles(f, pose).blend!;
          expect(outsideDistance(v, blend[0], blend[1], blend[2])).toBeCloseTo(f.blendDistance, 3);
          // And the outline reaches the volume's extent: its corners or rim are the volume's.
          const far = Math.max(...shape.wire(f, pose).flat().map((p) => Math.hypot(p[0] - v.cx, p[1] - v.cy, p[2] - v.cz)));
          expect(far).toBeCloseTo(shape.shape === "sphere" ? v.radius : Math.hypot(v.hx, v.hy, v.hz), 3);
        }
      }
    } finally {
      engine.dispose();
    }
  });

  it("sizes a negative size or radius by its magnitude, as colliders are sized", () => {
    expect(ZONE_SHAPES.box.volume(fields({ size: [-4, 2, 6] }), identity).half).toEqual([2, 1, 3]);
    expect(ZONE_SHAPES.sphere.volume(fields({ radius: -3 }), identity).radius).toBe(3);
  });
});

// Case A: node at (10, 0, 0), scale (2, 1, 1); box centre (1, 0, 0), size (4, 2, 6), blend 2.
//   world centre = (10 + 1 x 2, 0, 0) = (12, 0, 0); half extents = (4 x 2 / 2, 2 / 2, 6 / 2) = (4, 1, 3).
const poseA: Pose3D = { position: [10, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 1, 1] };
const boxA = fields({ center: [1, 0, 0], size: [4, 2, 6], radius: 5, blendDistance: 2 });

describe("box zone", () => {
  const box = ZONE_SHAPES.box;

  it("places the volume from the node's scale, turned with the node", () => {
    const g = box.volume(boxA, poseA);
    expect(g.center).toEqual([12, 0, 0]);
    expect(g.half).toEqual([4, 1, 3]);
    const turned = box.volume(boxA, { ...identity, rotation: Y90 });
    close(turned.center, [0, 0, -1]);
    close(turned.axes[0], [0, 0, -1]);
    close(turned.axes[2], [1, 0, 0]);
  });

  it("draws twelve edges between its corners and a shell of three rounded rectangles", () => {
    const wire = box.wire(boxA, poseA);
    expect(wire.length).toBe(12);
    expect(wire[0]).toEqual([[8, -1, -3], [16, -1, -3]]); // corner 0 to corner 1
    expect(wire[11]).toEqual([[16, 1, -3], [16, 1, 3]]); // corner 3 to corner 7
    const shell = box.shell(boxA, poseA);
    expect(shell.length).toBe(3);
    shell.forEach((loop) => {
      expect(loop.length).toBe(4 * (8 + 1) + 1); // 8 segments a quarter arc, first point repeated
      expect(loop[loop.length - 1]).toEqual(loop[0]);
    });
    close(shell[0]![0]!, [18, 1, 0]); // x-y plane: the +x +y corner arc starts straight out from the corner (16 + 2, 1)
    close(shell[0]![8]!, [16, 3, 0]); // and ends straight up from it
    expect(box.shell({ ...boxA, blendDistance: 0 }, poseA)).toEqual([]);
    expect(box.shell({ ...boxA, blendDistance: -1 }, poseA)).toEqual([]);
  });

  it("puts face handles at the face centres and the blend handle blendDistance out of the +x +y edge", () => {
    const h = box.handles(boxA, poseA);
    expect(Object.keys(h).sort()).toEqual(["blend", "x+", "x-", "y+", "y-", "z+", "z-"]);
    expect([h["x+"], h["x-"], h["y+"], h["y-"], h["z+"], h["z-"]]).toEqual([[16, 0, 0], [8, 0, 0], [12, 1, 0], [12, -1, 0], [12, 0, 3], [12, 0, -3]]);
    close(h.blend!, [16 + Math.SQRT2, 1 + Math.SQRT2, 0]);
    close(box.handles({ ...boxA, blendDistance: -3 }, poseA).blend!, [16, 1, 0]);
    const turned = box.handles(fields({ center: [1, 0, 0], size: [4, 2, 6] }), { ...identity, rotation: Y90 });
    close(turned["x+"]!, [0, 0, -3]); // centre (0, 0, -1) + 2 along -z
    close(turned["z+"]!, [3, 0, -1]); // centre + 3 along +x
  });

  it("drags a face with the opposite face fixed, both with Alt, never below the minimum, other axes alone", () => {
    // x+ out to 6 world units from the centre: the box spans 8..18, world size 10, size.x 5, centre.x 1.5.
    expect(box.press(boxA, poseA, "x+")!(6, false)).toEqual({ size: [5, 2, 6], center: [1.5, 0, 0] });
    expect(box.press(boxA, poseA, "x-")!(6, false)).toEqual({ size: [5, 2, 6], center: [0.5, 0, 0] });
    expect(box.press(boxA, poseA, "x+")!(6, true)).toEqual({ size: [6, 2, 6] });
    const shrunk = box.press(boxA, poseA, "y+")!(-100, false) as { size: V3; center: V3 };
    expect(shrunk.size[1]).toBeCloseTo(MIN_EXTENT, 9);
    expect(shrunk.center[1]).toBeCloseTo(-0.995, 9); // 0 + (0.005 - 1)
    expect((box.press(boxA, poseA, "z-")!(5, false) as { size: V3; center: V3 })).toEqual({ size: [4, 2, 8], center: [1, 0, -1] });
  });

  it("drags the blend handle: blendDistance is how far past the edge it is, never below 0", () => {
    const blend = box.press(boxA, poseA, "blend")!;
    const edge = (16 - 12) * S + 1 * S; // the +x +y edge's distance from the centre along the diagonal
    expect((blend(edge + 2.5, false) as { blendDistance: number }).blendDistance).toBeCloseTo(2.5, 9);
    expect(blend(edge - 1, false)).toEqual({ blendDistance: 0 });
    close(resizeAxis(box, boxA, poseA, "blend")!, [S, S, 0]);
  });
});

describe("sphere zone", () => {
  const sphere = ZONE_SHAPES.sphere;
  const scaled: Pose3D = { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [2, 1, 3] };

  it("sizes the radius by the largest scale axis and draws three great circles of it", () => {
    const f = fields({ radius: 5 });
    expect(sphere.volume(f, scaled).radius).toBe(15);
    const wire = sphere.wire(f, { ...scaled, position: [0, 0, 0] });
    expect(wire.length).toBe(3);
    wire.forEach((c) => {
      expect(c.length).toBe(32 + 1); // 32 segments a circle
      c.forEach((p) => expect(Math.hypot(...p)).toBeCloseTo(15, 9));
    });
    close(sphere.shell({ ...f, blendDistance: 2 }, identity)[0]![0]!, [7, 0, 0]); // radius + blendDistance
  });

  it("puts radius handles on the rim and the blend handle on the diagonal", () => {
    const h = sphere.handles(fields({ radius: 5 }), scaled);
    expect(h["radius:x+"]).toEqual([16, 2, 3]);
    expect(h["radius:x-"]).toEqual([-14, 2, 3]);
    expect(h["radius:y+"]).toEqual([1, 17, 3]);
    expect(h["radius:z-"]).toEqual([1, 2, -12]);
    close(sphere.handles(fields({ radius: 5, blendDistance: 2 }), identity).blend!, [7 * S, 7 * S, 0]);
  });

  it("turns a radius handle's reach into radius local units: 30 world / scale 3 = 10", () => {
    const press = sphere.press(fields({ radius: 5 }), scaled, "radius:x+")!;
    expect(press(30, false)).toEqual({ radius: 10 });
    expect(press(-30, false)).toEqual({ radius: 10 });
    expect(press(0, false)).toEqual({ radius: MIN_EXTENT });
    expect(sphere.press(fields(), scaled, "x+")).toBeNull(); // a box's face is no sphere handle
  });
});
