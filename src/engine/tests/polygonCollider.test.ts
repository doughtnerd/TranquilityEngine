import { describe, expect, it } from "vitest";
import { Assets, EdgeCollider2D, Engine, GameObject, PolygonCollider2D, RigidBody2D, SceneManager, CircleCollider2D, Physics2D, getComponentClass, getFields } from "../../myco";
import { cleanPoints, convexParts, isConvex, signedArea2, triangulate } from "../physics/polygon";

const area = (pts: readonly (readonly number[])[]) => Math.abs(signedArea2(pts as [number, number][])) / 2;

describe("polygon decomposition (ADR 0039)", () => {
  it("keeps a convex polygon whole and counter-clockwise, whichever way it was wound", () => {
    const cw: [number, number][] = [[0, 0], [0, 1], [1, 1], [1, 0]];
    const parts = convexParts(cw)!;
    expect(parts).toHaveLength(1);
    expect(signedArea2(parts[0])).toBeGreaterThan(0);
    expect(isConvex(parts[0])).toBe(true);
  });

  it("splits a concave L shape into convex parts covering the same area", () => {
    const l: [number, number][] = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
    expect(isConvex(l)).toBe(false);
    const parts = convexParts(l)!;
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.length).toBeLessThan(4); // triangles were merged back
    for (const p of parts) expect(isConvex(p)).toBe(true);
    expect(parts.reduce((s, p) => s + area(p), 0)).toBeCloseTo(3, 6);
  });

  it("triangulates into n - 2 triangles", () => {
    const star: [number, number][] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 0.4 : 1, a = (i / 10) * Math.PI * 2;
      star.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    const tris = triangulate(star)!;
    expect(tris).toHaveLength(8);
    expect(convexParts(star)!.reduce((s, p) => s + area(p), 0)).toBeCloseTo(area(star), 6);
  });

  it("rejects degenerate and self-crossing input, and cleans repeated points", () => {
    expect(convexParts([[0, 0], [1, 0]])).toBeNull();
    expect(convexParts([[0, 0], [1, 1], [2, 2]])).toBeNull();
    expect(convexParts([[0, 0], [1, 1], [1, 0], [0, 1]])).toBeNull(); // a bow tie
    expect(cleanPoints([[0, 0], [0, 0], [1, 0], [1, 1], [0, 0]])).toEqual([[0, 0], [1, 0], [1, 1]]);
  });
});

async function setup() {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics: "2d" }, nodes: [] } }));
  const engine = await Engine.create({ headless: true, project: { physics: { gravity: [0, -10] as [number, number] } } });
  await SceneManager.load("s.json");
  return engine;
}

const steps = (engine: Engine, n: number) => {
  for (let i = 0; i < n; i++) engine.step(1 / 60);
};

describe("PolygonCollider2D and EdgeCollider2D on Rapier (ADR 0039)", () => {
  it("are registered with serializable point fields", () => {
    expect(getComponentClass("engine.PolygonCollider2D")).toBe(PolygonCollider2D);
    expect(getComponentClass("engine.EdgeCollider2D")).toBe(EdgeCollider2D);
    expect(getFields(PolygonCollider2D).map((f) => f.name)).toContain("points");
  });

  it("a ball lands on a concave polygon's top, scaled with the node", async () => {
    const engine = await setup();
    const ground = GameObject.create("ground");
    ground.transform!.position.y = -2;
    ground.transform!.scale.set(2, 1, 1);
    // A U shape: the ball drops into the notch, onto the floor at local y = 0.
    ground.addBehavior(PolygonCollider2D, { points: [[-2, -1], [2, -1], [2, 1], [1, 1], [1, 0], [-1, 0], [-1, 1], [-2, 1]] });
    const ball = GameObject.create("ball");
    ball.addBehavior(RigidBody2D);
    ball.addBehavior(CircleCollider2D, { radius: 0.25 });
    steps(engine, 120);
    expect(ball.transform!.position.y).toBeCloseTo(-2 + 0.25, 1);
  });

  it("an edge collider is a floor; changing its points rebuilds it", async () => {
    const engine = await setup();
    const floor = GameObject.create("floor");
    const edge = floor.addBehavior(EdgeCollider2D, { points: [[-5, -1], [5, -1]] });
    const ball = GameObject.create("ball");
    ball.addBehavior(RigidBody2D);
    ball.addBehavior(CircleCollider2D, { radius: 0.5 });
    steps(engine, 90);
    expect(ball.transform!.position.y).toBeCloseTo(-0.5, 1);
    expect(Physics2D.raycast({ x: 3, y: 5 }, { x: 0, y: -1 })?.collider).toBe(edge);
    edge.points = [[-5, -3], [5, -3]];
    steps(engine, 90);
    expect(ball.transform!.position.y).toBeCloseTo(-2.5, 1);
  });
});
