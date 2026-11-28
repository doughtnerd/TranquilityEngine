// The collider shape table (ADR 0288), driven entry by entry: property tests over random fields and poses
// ("dragging a handle to where it is leaves the shape unchanged"; "the outline is where the physics backend's
// shape is", measured with raycasts against the real Rapier worlds, mirrored nodes included, ADR 0301), then
// examples of each entry's rules. An entry's fields are the collider class's own shape fields and its centre (ADR 0305).
import { describe, expect, it } from "vitest";
import {
  Assets,
  BoxCollider,
  BoxCollider2D,
  CapsuleCollider,
  CharacterController,
  CharacterController2D,
  CircleCollider2D,
  Engine,
  GameObject,
  Physics,
  Physics2D,
  PolygonCollider2D,
  SceneManager,
  SphereCollider,
  Vector2,
  Vector3,
  type Collider,
  type Collider2D,
} from "../../../myco";
import { polygonArea } from "../../../editor/polygonMath";
import { shapeKit3d } from "../../../editor/sdk";
import { frame2D, frame2DOf, frameToLocal, upright2D, type Frame2D } from "../../../engine/scene/frame2d";
import { COLLIDER_SHAPES, colliderShapeFor, colliderShapeOf, type AnyColliderShape2D, type AnyColliderShape3D, type EditableColliderType, type FieldPatch, type Press2D } from "./colliderShapes";

const { MIN_EXTENT, axisDrag, resizeAxis, worldCenter } = shapeKit3d;
type Pose3D = shapeKit3d.Pose3D;
type V3 = shapeKit3d.V3;

const close = (a: readonly number[], b: readonly number[], digits = 6) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
};

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

/** Random fields for each entry, as its `read` would give them. */
const FIELDS: Record<EditableColliderType, (r: Rnd) => object> = {
  "engine.BoxCollider2D": (r) => ({ kind: "box", center: [r.range(-2, 2), r.range(-2, 2)], size: [r.range(0.2, 4), r.range(0.2, 4)] }),
  "engine.CircleCollider2D": (r) => ({ kind: "circle", center: [r.range(-2, 2), r.range(-2, 2)], radius: r.range(0.1, 3) }),
  "engine.CharacterController2D": (r) => ({ kind: "capsule", center: [r.range(-2, 2), r.range(-2, 2)], radius: r.range(0.1, 1.5), height: r.range(0.1, 5) }),
  "engine.PolygonCollider2D": (r) => ({ kind: "polygon", center: [r.range(-1, 1), r.range(-1, 1)], points: Array.from({ length: 3 + Math.floor(r.next() * 4) }, () => [r.range(-3, 3), r.range(-3, 3)]) }),
  "engine.EdgeCollider2D": (r) => ({ kind: "edge", center: [r.range(-1, 1), r.range(-1, 1)], points: Array.from({ length: 2 + Math.floor(r.next() * 4) }, () => [r.range(-3, 3), r.range(-3, 3)]) }),
  "engine.BoxCollider": (r) => ({ kind: "box", center: [r.range(-2, 2), r.range(-2, 2), r.range(-2, 2)], size: [r.range(0.2, 4), r.range(0.2, 4), r.range(0.2, 4)] }),
  "engine.SphereCollider": (r) => ({ kind: "sphere", center: [r.range(-2, 2), r.range(-2, 2), r.range(-2, 2)], radius: r.range(0.1, 3) }),
  "engine.CapsuleCollider": (r) => ({ kind: "capsule", center: [r.range(-2, 2), r.range(-2, 2), r.range(-2, 2)], radius: r.range(0.1, 1.5), height: r.range(0.1, 5), axis: Math.floor(r.next() * 3) }),
  "engine.CharacterController": (r) => ({ kind: "capsule", center: [r.range(-2, 2), r.range(-2, 2), r.range(-2, 2)], radius: r.range(0.1, 1.5), height: r.range(0.1, 5), axis: 1, upright: true }),
  "engine.MeshCollider": (r) => ({ center: [r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)], mesh: { vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1], indices: [0, 1, 2, 0, 2, 3] } }),
};

const pose2D = (r: Rnd, upright: boolean): Frame2D => frame2D([r.range(-5, 5), r.range(-5, 5), r.range(-2, 2)], upright ? 0 : r.range(-Math.PI, Math.PI), [r.scale(), r.scale()]);
const pose3D = (r: Rnd, upright: boolean): Pose3D => ({ position: [r.range(-5, 5), r.range(-5, 5), r.range(-5, 5)], rotation: upright ? [0, 0, 0, 1] : unitQuat(r), scale: [r.scale(), r.scale(), r.scale()] });

const shapes2D = COLLIDER_SHAPES.filter((s): s is typeof s & AnyColliderShape2D => s.dimension === "2d");
const shapes3D = COLLIDER_SHAPES.filter((s): s is typeof s & AnyColliderShape3D => s.dimension === "3d");
/** A ray that hits world point `at` square across the unit `axis`. */
function rayOnto(at: V3, axis: V3): shapeKit3d.Ray3D {
  const helper = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const n = [axis[1] * helper[2] - axis[2] * helper[1], axis[2] * helper[0] - axis[0] * helper[2], axis[0] * helper[1] - axis[1] * helper[0]];
  const len = Math.hypot(n[0], n[1], n[2]);
  const d = n.map((v) => -v / len);
  return { origin: [at[0] - d[0] * 5, at[1] - d[1] * 5, at[2] - d[2] * 5], direction: d };
}
const apply = <F extends object>(f: F, patch: FieldPatch): F => ({ ...f, ...patch });
const identitySnap = (n: number) => n;
const drag2D = (press: Press2D | null) => (press && "drag" in press ? press : null);

describe("every entry of the collider shape table (ADR 0288)", () => {
  it("covers each editable collider type once, and finds the entry for a Component and a type id", () => {
    expect(COLLIDER_SHAPES.map((s) => s.type).sort()).toEqual(Object.keys(FIELDS).sort());
    expect(colliderShapeOf(new BoxCollider2D() as Collider2D)?.type).toBe("engine.BoxCollider2D");
    expect(colliderShapeOf(new CapsuleCollider() as Collider)?.type).toBe("engine.CapsuleCollider");
    expect(colliderShapeFor("engine.ShapeCollider2D")).toBeUndefined();
  });

  for (const shape of shapes2D) {
    it(`${shape.type}: dragging any handle to where it is leaves the outline unchanged, Alt or not`, () => {
      const r = random(shape.type.length * 7919);
      for (let n = 0; n < 40; n++) {
        const f = FIELDS[shape.type](r) as { center: [number, number] }, pose = pose2D(r, shape.upright);
        const outline = shape.outline(f, pose).points;
        for (const [id, at] of Object.entries(shape.handles(f, pose))) {
          if (id === "center") continue;
          const press = drag2D(shape.press(f, pose, id, { ctrl: false }));
          expect(press, id).not.toBeNull();
          const start = press!.start ? apply(f, press!.start) : f; // an insert handle adds its point first
          for (const alt of [false, true]) {
            const after = apply(start, press!.drag(frameToLocal(pose, at), alt, identitySnap));
            close(shape.outline(after, pose).points.flat(), shape.outline(start, pose).points.flat());
          }
        }
        expect(outline.length).toBeGreaterThan(1);
      }
    });
  }

  for (const shape of shapes3D) {
    it(`${shape.type}: dragging any handle out to where it is leaves the wireframe unchanged, Alt or not`, () => {
      const r = random(shape.type.length * 104729);
      for (let n = 0; n < 40; n++) {
        const f = FIELDS[shape.type](r) as { center: V3 }, pose = pose3D(r, shape.upright);
        const wire = shape.wire(f, pose).flat().flat();
        const handles = shape.handles(f, pose), c = worldCenter(pose, f.center);
        for (const [id, at] of Object.entries(handles)) {
          if (id === "center") continue;
          const axis = resizeAxis(shape, f, pose, id)!;
          expect((at[0] - c[0]) * axis[0] + (at[1] - c[1]) * axis[1] + (at[2] - c[2]) * axis[2]).toBeGreaterThan(0); // the axis points outwards
          // A pointer ray onto the handle, across its axis, pressed and moved nowhere: the kit's axis drag, as the gizmo runs it.
          const ray = rayOnto(at, axis);
          const drag = axisDrag(shape, f, pose, id, ray);
          expect(drag, id).not.toBeNull();
          for (const alt of [false, true]) close(shape.wire(apply(f, drag!(ray, alt)!), pose).flat().flat(), wire);
        }
      }
    });
  }
});

// --- the outline is the simulated shape -------------------------------------------------------------

async function world(physics: "2d" | "3d") {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics }, nodes: [] } }));
  const engine = await Engine.create({ headless: true });
  await SceneManager.load("s.json");
  return engine;
}

/** A node at a random pose (in 2D, a mirrored scale one time in three), its transform as the 2D or 3D pose the table takes. */
function placed(r: Rnd, dimension: "2d" | "3d") {
  const node = GameObject.create("shape");
  const t = node.transform!;
  t.position.set(r.range(-5, 5), r.range(-5, 5), dimension === "2d" ? 0 : r.range(-5, 5));
  const flip = () => (dimension === "2d" && r.next() < 0.33 ? -1 : 1);
  t.scale.set(r.range(0.4, 2.5) * flip(), r.range(0.4, 2.5) * flip(), dimension === "2d" ? 1 : r.range(0.4, 2.5));
  if (dimension === "2d") t.rotation2D = r.range(-Math.PI, Math.PI);
  else t.eulerAngles = { x: r.range(-1.5, 1.5), y: r.range(-Math.PI, Math.PI), z: r.range(-Math.PI, Math.PI) };
  return node;
}

describe("the outline is where the physics backend's shape is (ADR 0288)", () => {
  it("2D: a ray from outside towards each handle hits the collider at that handle, mirrored nodes included", async () => {
    const engine = await world("2d");
    const r = random(2);
    for (let n = 0; n < 24; n++) {
      const node = placed(r, "2d");
      const kind = n % 3;
      const c: Collider2D =
        kind === 0
          ? node.addBehavior(BoxCollider2D, { size: new Vector2(r.range(0.3, 3), r.range(0.3, 3)) })
          : kind === 1
            ? node.addBehavior(CircleCollider2D, { radius: r.range(0.2, 1.5) })
            : node.addBehavior(CharacterController2D, { radius: r.range(0.2, 1.5), height: r.range(0.2, 4) });
      c.center.set(r.range(-1, 1), r.range(-1, 1));
      engine.step(1 / 60);
      const shape = colliderShapeOf(c)!;
      const frame = frame2DOf(node), pose = shape.upright ? upright2D(frame) : frame;
      const handles = shape.handles(shape.read(c)!, pose);
      const center = handles.center;
      for (const [id, at] of Object.entries(handles)) {
        if (id === "center") continue;
        const d = [at[0] - center[0], at[1] - center[1]], len = Math.hypot(d[0], d[1]);
        const dir = { x: -d[0] / len, y: -d[1] / len };
        const hit = Physics2D.raycast({ x: center[0] - dir.x * 50, y: center[1] - dir.y * 50 }, dir, 100);
        expect(hit?.collider, `${shape.type} ${id}`).toBe(c);
        close([hit!.point.x, hit!.point.y], [at[0], at[1]], 3);
      }
      GameObject.destroy(node);
      engine.step(1 / 60);
    }
    engine.dispose();
  });

  it("3D: a ray from outside towards each handle hits the collider at that handle", async () => {
    const engine = await world("3d");
    const r = random(3);
    for (let n = 0; n < 16; n++) {
      const node = placed(r, "3d");
      const kind = n % 4;
      const c: Collider =
        kind === 0
          ? node.addBehavior(BoxCollider, { size: new Vector3(r.range(0.3, 3), r.range(0.3, 3), r.range(0.3, 3)) })
          : kind === 1
            ? node.addBehavior(SphereCollider, { radius: r.range(0.2, 1.5) })
            : kind === 2
              ? node.addBehavior(CapsuleCollider, { radius: r.range(0.2, 1.5), height: r.range(0.2, 4), direction: (["x", "y", "z"] as const)[(n >> 2) % 3] })
              : node.addBehavior(CharacterController, { radius: r.range(0.2, 1.5), height: r.range(0.2, 4) });
      c.center.set(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1));
      engine.step(1 / 60);
      const shape = colliderShapeOf(c)!;
      const t = node.transform!, p = t.worldPosition, q = t.worldRotation, s = t.worldScale;
      const pose: Pose3D = { position: [p.x, p.y, p.z], rotation: shape.upright ? [0, 0, 0, 1] : [q.x, q.y, q.z, q.w], scale: [s.x, s.y, s.z] };
      const handles = shape.handles(shape.read(c)!, pose);
      const center = handles.center;
      for (const [id, at] of Object.entries(handles)) {
        if (id === "center") continue;
        const d = [at[0] - center[0], at[1] - center[1], at[2] - center[2]], len = Math.hypot(d[0], d[1], d[2]);
        const dir = { x: -d[0] / len, y: -d[1] / len, z: -d[2] / len };
        const hit = Physics.raycast({ x: center[0] - dir.x * 50, y: center[1] - dir.y * 50, z: center[2] - dir.z * 50 }, dir, 100);
        expect(hit?.collider, `${shape.type} ${id}`).toBe(c);
        close([hit!.point.x, hit!.point.y, hit!.point.z], [at[0], at[1], at[2]], 3);
      }
      GameObject.destroy(node);
      engine.step(1 / 60);
    }
    engine.dispose();
  });
});

// --- each entry's rules, by example -------------------------------------------------------------------

const identity2D: Frame2D = frame2D([0, 0, 0], 0, [1, 1]);
const identity3D: Pose3D = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const turnY90: Pose3D["rotation"] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const entry2D = (type: EditableColliderType) => colliderShapeFor(type) as AnyColliderShape2D;
const entry3D = (type: EditableColliderType) => colliderShapeFor(type) as AnyColliderShape3D;
/** What dragging 2D `handle` to local point `p` writes. */
const dragged2D = (type: EditableColliderType, f: object, handle: string, p: [number, number], alt = false, pose = identity2D) => drag2D(entry2D(type).press(f, pose, handle, { ctrl: false }))!.drag(p, alt, identitySnap);

describe("2D entries", () => {
  it("box: corners and edge handles around the offset centre, scaled and turned with the node", () => {
    const box = entry2D("engine.BoxCollider2D");
    expect(box.outline({ kind: "box", center: [1, 0], size: [4, 2] }, identity2D)).toEqual({ points: [[-1, -1, 0], [3, -1, 0], [3, 1, 0], [-1, 1, 0]], closed: true });
    expect(box.handles({ kind: "box", center: [0, 0], size: [4, 2] }, { ...identity2D, scale: [2, 1] })).toMatchObject({ left: [-4, 0, 0], right: [4, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0], center: [0, 0, 0] });
    const turned = box.outline({ kind: "box", center: [0, 0], size: [2, 2] }, { ...identity2D, angle: Math.PI / 4 }).points;
    expect(polygonArea(turned)).toBeCloseTo(4);
    close(turned[0], [0, -Math.SQRT2, 0]);
  });

  it("box: drags one edge with the opposite edge fixed, both with Alt, and never past the opposite edge", () => {
    const f = { kind: "box", center: [0, 0], size: [2, 2] };
    expect(dragged2D("engine.BoxCollider2D", f, "right", [3, 5])).toEqual({ center: [1, 0], size: [4, 2] });
    expect(dragged2D("engine.BoxCollider2D", f, "bottom", [0, -3])).toEqual({ center: [0, -1], size: [2, 4] });
    expect(dragged2D("engine.BoxCollider2D", { kind: "box", center: [1, 0], size: [2, 2] }, "left", [-3, 0], true)).toEqual({ size: [8, 2] }); // the centre stays
    const r = dragged2D("engine.BoxCollider2D", f, "right", [-5, 0]) as { center: number[]; size: number[] };
    expect(r.size[0]).toBeCloseTo(MIN_EXTENT);
    expect(r.center[0]).toBeCloseTo(-1 + MIN_EXTENT / 2);
  });

  it("circle: sized by the larger scale axis, rim handles turning with the node, the radius undoing the scale", () => {
    const circle = entry2D("engine.CircleCollider2D"), pose: Frame2D = { ...identity2D, scale: [1, 3] };
    close(circle.outline({ kind: "circle", center: [0, 0], radius: 0.5 }, pose).points[0], [1.5, 0, 0]);
    close(circle.handles({ kind: "circle", center: [0, 0], radius: 0.5 }, { ...pose, angle: Math.PI / 2 })["radius-right"], [0, 1.5, 0]);
    expect(polygonArea(circle.outline({ kind: "circle", center: [0, 0], radius: 1 }, identity2D).points)).toBeCloseTo(Math.PI, 1);
    const scaled: Frame2D = { ...identity2D, scale: [2, 2] };
    expect((dragged2D("engine.CircleCollider2D", { kind: "circle", center: [0, 0], radius: 1 }, "radius-top", frameToLocal(scaled, [3, 4]), false, scaled) as { radius: number }).radius).toBeCloseTo(2.5);
    expect(dragged2D("engine.CircleCollider2D", { kind: "circle", center: [0, 0], radius: 1 }, "radius-top", [0, 0])).toEqual({ radius: MIN_EXTENT });
  });

  it("character controller: an upright capsule, radius by |scale.x| and height by |scale.y|, dragged in local units", () => {
    const capsule = entry2D("engine.CharacterController2D"), pose = frame2D([1, 2, 0], 0, [2, 1]);
    expect(capsule.upright).toBe(true);
    const f = { kind: "capsule", center: [0, 0], radius: 0.5, height: 4 };
    const h = capsule.handles(f, pose);
    close(h["radius-right"], [2, 2, 0]);
    close(h["height-top"], [1, 4, 0]);
    close(h["height-bottom"], [1, 0, 0]);
    const pts = capsule.outline(f, pose).points;
    expect(pts).toHaveLength(34);
    expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(4);
    expect(Math.min(...pts.map((p) => p[0]))).toBeCloseTo(0);
    expect((dragged2D("engine.CharacterController2D", f, "radius-left", [0.7, 3]) as { radius: number }).radius).toBeCloseTo(0.7);
    expect((dragged2D("engine.CharacterController2D", f, "height-bottom", [0, -1.5]) as { height: number }).height).toBeCloseTo(3);
    expect(dragged2D("engine.CharacterController2D", f, "radius-right", [0, 0])).toEqual({ radius: MIN_EXTENT });
  });

  it("a zero-radius capsule is drawn at the backend's smallest size, as the physics world builds it (no more gizmo/backend mismatch)", () => {
    const capsule = entry2D("engine.CharacterController2D");
    const h = capsule.handles({ kind: "capsule", center: [0, 0], radius: 0, height: 1 }, identity2D);
    expect(h["radius-right"][0]).toBeCloseTo(1e-4, 8);
  });

  it("polygon and edge: a vertex handle per point, an insert handle per edge (the closing one only when closed), offset by the centre", () => {
    const square = [[0, 0], [2, 0], [2, 2], [0, 2]];
    const polygon = entry2D("engine.PolygonCollider2D"), edge = entry2D("engine.EdgeCollider2D");
    const closed = polygon.handles({ kind: "polygon", center: [1, 0], points: square }, identity2D);
    expect(closed["vertex:1"]).toEqual([3, 0, 0]);
    expect(closed["insert:3"]).toEqual([1, 1, 0]);
    expect(Object.keys(edge.handles({ kind: "edge", center: [0, 0], points: square }, identity2D)).filter((k) => k.startsWith("insert:"))).toHaveLength(3);
    expect(polygon.outline({ kind: "polygon", center: [0, 0], points: [[1, 1]] }, { ...identity2D, scale: [2, 1] })).toEqual({ points: [[2, 1, 0]], closed: true });
    expect(edge.outline({ kind: "edge", center: [0, 0], points: square }, identity2D).closed).toBe(false);
  });

  it("polygon and edge: vertices drag (snapped), an insert handle adds the edge's middle point and drags it, Ctrl+click removes down to the minimum", () => {
    const square = [[0, 0], [2, 0], [2, 2], [0, 2]], f = { kind: "polygon", center: [1, 1], points: square };
    const polygon = entry2D("engine.PolygonCollider2D"), edge = entry2D("engine.EdgeCollider2D");
    const move = drag2D(polygon.press(f, identity2D, "vertex:2", { ctrl: false }))!;
    expect(move.label).toBe("Move collider vertex");
    expect((move.drag([4.2, 4.4], false, Math.round) as { points: number[][] }).points[2]).toEqual([3, 3]); // relative to the centre, snapped
    const insert = drag2D(polygon.press(f, identity2D, "insert:3", { ctrl: false }))!;
    expect(insert.start).toEqual({ points: [[0, 0], [2, 0], [2, 2], [0, 2], [0, 1]] });
    expect((insert.drag([0, 0], false, identitySnap) as { points: number[][] }).points[4]).toEqual([-1, -1]);
    expect(polygon.press(f, identity2D, "vertex:0", { ctrl: true })).toEqual({ label: "Remove collider vertex", edit: { points: [[2, 0], [2, 2], [0, 2]] } });
    expect(polygon.press({ kind: "polygon", center: [0, 0], points: square.slice(0, 3) }, identity2D, "vertex:0", { ctrl: true })).toEqual({ refused: "A polygon collider needs at least 3 points." });
    expect(edge.press({ kind: "edge", center: [0, 0], points: square.slice(0, 2) }, identity2D, "vertex:0", { ctrl: true })).toEqual({ refused: "An edge collider needs at least 2 points." });
    expect(polygon.press(f, identity2D, "vertex:9", { ctrl: false })).toBeNull();
  });

  it("polygon and edge: read points as pairs or {x, y}, dropping malformed ones", () => {
    const c = new PolygonCollider2D();
    c.points = [[1, 2], { x: 3, y: 4 }, ["a", 1], null] as unknown as PolygonCollider2D["points"];
    expect(entry2D("engine.PolygonCollider2D").read(c)).toEqual({ kind: "polygon", center: [0, 0], points: [[1, 2], [3, 4]] });
  });
});

describe("3D entries", () => {
  it("box: face handles scaled, turned and offset like the physics shape; twelve edges", () => {
    const box = entry3D("engine.BoxCollider");
    const h = box.handles({ kind: "box", center: [0.5, 0, 0], size: [1, 2, 4] }, { position: [1, 2, 3], rotation: turnY90, scale: [2, 1, 1] });
    close(h.center, [1, 2, 2]); // centre (0.5 × 2) along the node's x, which faces -z
    close(h["x+"], [1, 2, 1]);
    close(h["y+"], [1, 3, 2]);
    close(h["z-"], [-1, 2, 2]);
    expect(box.wire({ kind: "box", center: [0, 0, 0], size: [1, 1, 1] }, identity3D)).toHaveLength(12);
  });

  it("box: drags a face with the opposite face fixed, or both with Alt", () => {
    const box = entry3D("engine.BoxCollider"), f = { kind: "box", center: [0, 0, 0], size: [2, 2, 2] };
    expect(box.press(f, identity3D, "x+")!(2, false)).toEqual({ center: [0.5, 0, 0], size: [3, 2, 2] });
    expect(box.press(f, identity3D, "y-")!(3, false)).toEqual({ center: [0, -1, 0], size: [2, 4, 2] });
    expect(box.press({ kind: "box", center: [0, 0, 1], size: [2, 2, 2] }, identity3D, "z+")!(2, true)).toEqual({ size: [2, 2, 4] });
    expect(box.press({ kind: "box", center: [0, 0, 0], size: [2, 1, 1] }, { ...identity3D, scale: [2, 1, 1] }, "x+")!(4, false)).toEqual({ center: [0.5, 0, 0], size: [3, 1, 1] }); // world 2…4 → local
  });

  it("sphere and capsule: handles by the scale rules, and reaches turned back into radius and height", () => {
    const sphere = entry3D("engine.SphereCollider"), capsule = entry3D("engine.CapsuleCollider");
    close(sphere.handles({ kind: "sphere", center: [0, 0, 0], radius: 0.5 }, { ...identity3D, scale: [1, 3, 1] })["radius:x+"], [1.5, 0, 0]);
    const c = capsule.handles({ kind: "capsule", center: [0, 0, 0], radius: 0.5, height: 3, axis: 2 }, identity3D);
    close(c["height+"], [0, 0, 1.5]);
    close(c["radius:u+"], [0.5, 0, 0]); // across z: x first
    expect(capsule.wire({ kind: "capsule", center: [0, 0, 0], radius: 0.5, height: 3, axis: 1 }, identity3D)).toHaveLength(10); // two rings, four sides, four caps
    expect(sphere.press({ kind: "sphere", center: [0, 0, 0], radius: 1 }, { ...identity3D, scale: [1, 2, 1] }, "radius:x+")!(3, false)).toEqual({ radius: 1.5 });
    const f = { kind: "capsule", center: [0, 0, 0], radius: 1, height: 2, axis: 1 };
    expect(capsule.press(f, { ...identity3D, scale: [2, 5, 1] }, "radius:u+")!(1, false)).toEqual({ radius: 0.5 });
    expect(capsule.press(f, { ...identity3D, scale: [1, 2, 1] }, "height+")!(2, false)).toEqual({ height: 2 });
    close(resizeAxis(capsule, f, identity3D, "height-")!, [0, -1, 0]);
  });

  it("character controller: an upright y capsule with the capsule's handles", () => {
    const cc = entry3D("engine.CharacterController");
    expect(cc.upright).toBe(true);
    const wire = cc.wire({ kind: "capsule", center: [0, 0, 0], radius: 0.5, height: 2, axis: 1, upright: true }, identity3D);
    expect(wire.flat().every((p) => Math.abs(p[1]) <= 1 + 1e-9)).toBe(true);
  });

  it("mesh: drawn by triangle edges (shared ones once) or, when big, by the box around it; only the centre is a handle", () => {
    const mesh = entry3D("engine.MeshCollider");
    const quad = { center: [0, 0, 0], mesh: { vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], indices: [0, 1, 2, 0, 2, 3] } };
    expect(mesh.wire(quad, identity3D)).toHaveLength(5);
    const big = { center: [0, 0, 0], mesh: { vertices: [0, 0, 0, 2, 0, 0, 2, 4, 0], indices: Array.from({ length: 2001 * 3 }, (_, i) => i % 3) } }; // over 2000 triangles
    const box = mesh.wire(big, identity3D);
    expect(box).toHaveLength(12);
    const xs = box.flat().map((p) => p[0]), ys = box.flat().map((p) => p[1]);
    close([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [0, 2, 0, 4]);
    expect(Object.keys(mesh.handles(quad, identity3D))).toEqual(["center"]);
    expect(mesh.press(quad, identity3D, "center")).toBeNull();
  });
});
