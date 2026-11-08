import { describe, expect, it } from "vitest";
import {
  Assets,
  BoxCollider,
  BoxCollider2D,
  CircleCollider2D,
  Engine,
  GameObject,
  Physics,
  Physics2D,
  Quaternion,
  SceneManager,
  SphereCollider,
} from "../../myco";

const project = { physics: { gravity: [0, 0] as [number, number], layers: ["Default", "Player", "Ghost"] } };

async function setup(mode: "2d" | "3d") {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics: mode }, nodes: [] } }));
  const engine = await Engine.create({ headless: true, project });
  await SceneManager.load("s.json");
  return engine;
}

function box3(name: string, x: number, y = 0, layer = "Default", size = 1) {
  const go = GameObject.create(name);
  go.transform!.position.set(x, y, 0);
  go.addBehavior(BoxCollider, { layer }).size.set(size, size, size);
  return go;
}

function box2(name: string, x: number, y = 0, layer = "Default") {
  const go = GameObject.create(name);
  go.transform!.position.set(x, y, 0);
  go.addBehavior(BoxCollider2D, { layer }).size.set(1, 1);
  return go;
}

const names = (cs: { node: { name: string } }[]) => cs.map((c) => c.node.name).sort();
const X = { x: 1, y: 0, z: 0 };

describe("3D shape casts and overlaps", () => {
  it("sphereCast hits the wall at the expected distance and world point", async () => {
    const engine = await setup("3d");
    box3("wall", 10);
    engine.step(1 / 60);
    const hit = Physics.sphereCast({ x: 0, y: 0, z: 0 }, 0.5, X)!;
    expect(hit.collider.node.name).toBe("wall");
    expect(hit.distance).toBeCloseTo(9, 3);
    expect(hit.point.x).toBeCloseTo(9.5, 3);
    expect(hit.normal.x).toBeCloseTo(-1, 3);
    expect(Physics.sphereCast({ x: 0, y: 0, z: 0 }, 0.5, { x: -1, y: 0, z: 0 })).toBeNull();
    expect(Physics.sphereCast({ x: 0, y: 0, z: 0 }, 0.5, X, 5)).toBeNull();
  });

  it("boxCast and capsuleCast", async () => {
    const engine = await setup("3d");
    box3("wall", 10);
    engine.step(1 / 60);
    const b = Physics.boxCast({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, X)!;
    expect(b.distance).toBeCloseTo(8.5, 3);
    // Rotated 45 degrees about Z, the box corner leads: reach = sqrt(2) instead of 1.
    const r = Physics.boxCast({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, X, Quaternion.fromEuler(0, 0, 45))!;
    expect(r.distance).toBeCloseTo(10 - 0.5 - Math.SQRT2, 2);
    // Vertical capsule (caps on Y), radius 0.5: leading extent 0.5 in X.
    const c = Physics.capsuleCast({ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }, 0.5, X)!;
    expect(c.distance).toBeCloseTo(9, 3);
    // Horizontal capsule along X: leading extent = 1 + 0.5.
    const h = Physics.capsuleCast({ x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0.5, X)!;
    expect(h.distance).toBeCloseTo(10 - 0.5 - 1.5, 2);
    // Pointing downwards (180 degree flip) still works.
    const d = Physics.capsuleCast({ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, 0.5, X)!;
    expect(d.distance).toBeCloseTo(9, 3);
  });

  it("casts report distance 0 when starting inside a collider", async () => {
    const engine = await setup("3d");
    box3("wall", 0, 0, "Default", 4);
    engine.step(1 / 60);
    expect(Physics.sphereCast({ x: 0, y: 0, z: 0 }, 0.5, X)?.distance).toBeCloseTo(0, 3);
  });

  it("respects layers", async () => {
    const engine = await setup("3d");
    box3("ghost", 5, 0, "Ghost");
    box3("wall", 10, 0, "Default");
    engine.step(1 / 60);
    expect(Physics.sphereCast({ x: 0, y: 0, z: 0 }, 0.5, X)?.collider.node.name).toBe("ghost");
    expect(Physics.sphereCast({ x: 0, y: 0, z: 0 }, 0.5, X, undefined, ["Default"])?.collider.node.name).toBe("wall");
    expect(Physics.sphereCast({ x: 0, y: 0, z: 0 }, 0.5, X, undefined, ["Player"])).toBeNull();
    expect(names(Physics.overlapSphere({ x: 7, y: 0, z: 0 }, 10))).toEqual(["ghost", "wall"]);
    expect(names(Physics.overlapSphere({ x: 7, y: 0, z: 0 }, 10, ["Ghost"]))).toEqual(["ghost"]);
  });

  it("overlaps return exactly the overlapping colliders", async () => {
    const engine = await setup("3d");
    box3("a", 0);
    box3("b", 3);
    box3("c", 20);
    const s = GameObject.create("s");
    s.transform!.position.set(0, 5, 0);
    s.addBehavior(SphereCollider).radius = 0.5;
    engine.step(1 / 60);
    expect(names(Physics.overlapSphere({ x: 1.5, y: 0, z: 0 }, 1.2))).toEqual(["a", "b"]);
    expect(Physics.checkSphere({ x: 1.5, y: 0, z: 0 }, 1.2)).toBe(true);
    expect(Physics.checkSphere({ x: 10, y: 0, z: 0 }, 1)).toBe(false);
    expect(names(Physics.overlapBox({ x: 3, y: 0, z: 0 }, { x: 0.6, y: 0.6, z: 0.6 }))).toEqual(["b"]);
    expect(names(Physics.overlapBox({ x: 0, y: 5, z: 0 }, { x: 1, y: 1, z: 1 }))).toEqual(["s"]);
    expect(names(Physics.overlapCapsule({ x: 0, y: -2, z: 0 }, { x: 0, y: 2, z: 0 }, 0.3))).toEqual(["a"]);
    expect(names(Physics.overlapCapsule({ x: 0, y: 5, z: -2 }, { x: 0, y: 5, z: 2 }, 0.3))).toEqual(["s"]);
  });
});

describe("2D shape casts and overlaps", () => {
  it("circleCast, boxCast and capsuleCast hit at the expected distance", async () => {
    const engine = await setup("2d");
    box2("wall", 10);
    engine.step(1 / 60);
    const o = { x: 0, y: 0 }, dir = { x: 1, y: 0 };
    const c = Physics2D.circleCast(o, 0.5, dir)!;
    expect(c.collider.node.name).toBe("wall");
    expect(c.distance).toBeCloseTo(9, 3);
    expect(c.point.x).toBeCloseTo(9.5, 3);
    expect(c.normal.x).toBeCloseTo(-1, 3);
    expect(Physics2D.circleCast(o, 0.5, { x: -1, y: 0 })).toBeNull();
    expect(Physics2D.boxCast(o, { x: 2, y: 2 }, 0, dir)!.distance).toBeCloseTo(8.5, 3);
    expect(Physics2D.boxCast(o, { x: 2, y: 2 }, 45, dir)!.distance).toBeCloseTo(10 - 0.5 - Math.SQRT2, 2);
    // Vertical capsule 1 x 3: radius 0.5.
    expect(Physics2D.capsuleCast(o, { x: 1, y: 3 }, 0, dir)!.distance).toBeCloseTo(9, 3);
    // Rotated 90 degrees: half length 1.5 leads.
    expect(Physics2D.capsuleCast(o, { x: 1, y: 3 }, 90, dir)!.distance).toBeCloseTo(10 - 0.5 - 1.5, 2);
  });

  it("respects layers", async () => {
    const engine = await setup("2d");
    box2("ghost", 5, 0, "Ghost");
    box2("wall", 10, 0, "Default");
    engine.step(1 / 60);
    const o = { x: 0, y: 0 }, dir = { x: 1, y: 0 };
    expect(Physics2D.circleCast(o, 0.25, dir)?.collider.node.name).toBe("ghost");
    expect(Physics2D.circleCast(o, 0.25, dir, undefined, ["Default"])?.collider.node.name).toBe("wall");
    expect(Physics2D.circleCast(o, 0.25, dir, undefined, ["Player"])).toBeNull();
    expect(names(Physics2D.overlapCircle({ x: 7, y: 0 }, 10, ["Ghost"]))).toEqual(["ghost"]);
  });

  it("overlaps return exactly the overlapping colliders", async () => {
    const engine = await setup("2d");
    box2("a", 0);
    box2("b", 3);
    const ball = GameObject.create("ball");
    ball.transform!.position.set(0, 6, 0);
    ball.addBehavior(CircleCollider2D, { radius: 0.5 });
    engine.step(1 / 60);
    expect(names(Physics2D.overlapCircle({ x: 1.5, y: 0 }, 1.2))).toEqual(["a", "b"]);
    expect(names(Physics2D.overlapBox({ x: 3, y: 0 }, { x: 1.2, y: 1.2 }))).toEqual(["b"]);
    expect(names(Physics2D.overlapCapsule({ x: 0, y: 0 }, { x: 1, y: 3 }, 0))).toEqual(["a"]);
    expect(names(Physics2D.overlapCapsule({ x: 0, y: 5 }, { x: 1, y: 3 }, 0))).toEqual(["ball"]);
    expect(names(Physics2D.overlapPoint({ x: 3.2, y: 0.2 }))).toEqual(["b"]);
    expect(Physics2D.overlapPoint({ x: 100, y: 0 })).toEqual([]);
  });
});
