// Mirrored 2D nodes in the 2D physics world (ADR 0301): a node scaled (-1, 1) is mirrored, not turned half a turn.
// Driven through the public API only: Transforms, the 2D Components, Physics2D's queries and the World step.
import { describe, expect, it } from "vitest";
import { Assets, BoxCollider2D, CircleCollider2D, Engine, GameObject, HingeJoint2D, Physics2D, PolygonCollider2D, RigidBody2D, SceneManager, Vector2, type Collider2D } from "../../myco";

async function world(gravity: [number, number] = [0, 0]) {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics: "2d" }, nodes: [] } }));
  const engine = await Engine.create({ headless: true, project: { physics: { gravity } } });
  await SceneManager.load("s.json");
  return engine;
}

const steps = (engine: Engine, n: number) => {
  for (let i = 0; i < n; i++) engine.step(1 / 60);
};

/** The 2D part of a node's world matrix: [m00, m10, m01, m11]. */
const linear2D = (node: GameObject) => {
  const m = node.transform!.localToWorld.value;
  return [m[0], m[1], m[4], m[5]];
};

const close = (a: readonly number[], b: readonly number[], digits = 4) => a.forEach((v, i) => expect(v, `${i}: ${a} vs ${b}`).toBeCloseTo(b[i], digits));

/** A world point of `node`'s local point. */
const worldPoint = (node: GameObject, x: number, y: number) => {
  const p = node.transform!.localToWorld.transformPoint({ x, y, z: 0 });
  return [p.x, p.y];
};

/** A ray from 20 units outside `at` along the outward `normal` hits `c` at `at`. */
function expectSurfaceAt(c: Collider2D, at: number[], normal: number[]) {
  const len = Math.hypot(normal[0], normal[1]);
  const n = [normal[0] / len, normal[1] / len];
  const hit = Physics2D.raycast({ x: at[0] + n[0] * 20, y: at[1] + n[1] * 20 }, { x: -n[0], y: -n[1] }, 40);
  expect(hit?.collider, `ray onto ${at}`).toBe(c);
  close([hit!.point.x, hit!.point.y], at, 3);
}

/** Every edge midpoint of a triangle collider on `node` lies on the simulated shape, where the world matrix puts it. */
function expectTriangleWhereMatrixPutsIt(c: PolygonCollider2D) {
  const pts = c.points.map(([x, y]) => worldPoint(c.node, x + c.center.x, y + c.center.y));
  // The triangle's winding in world space (mirroring flips it), so the outward normal of each edge is known.
  const area = (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[2][0] - pts[0][0]) * (pts[1][1] - pts[0][1]);
  for (let i = 0; i < 3; i++) {
    const a = pts[i], b = pts[(i + 1) % 3];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d = [b[0] - a[0], b[1] - a[1]];
    expectSurfaceAt(c, mid, area > 0 ? [d[1], -d[0]] : [-d[1], d[0]]);
  }
}

const TRIANGLE: [number, number][] = [[0, 0], [2, 0.5], [0.5, 1.5]];

describe("mirrored 2D nodes in the physics world (ADR 0301)", () => {
  it("an X-mirrored dynamic body stays X-mirrored after its first awake step (it used to turn upside down)", async () => {
    const engine = await world([0, -10]);
    for (const angle of [0, 0.7]) {
      const node = GameObject.create("mirrored");
      node.transform!.position.x = angle * 10; // apart from the last one
      node.transform!.scale.set(-1, 1, 1);
      node.transform!.rotation2D = angle;
      node.addBehavior(RigidBody2D);
      node.addBehavior(BoxCollider2D, { size: new Vector2(1, 1) });
      const before = linear2D(node);
      steps(engine, 3);
      close(linear2D(node), before);
      expect(node.transform!.scale.x).toBe(-1);
      GameObject.destroy(node);
    }
    engine.dispose();
  });

  it("an X-mirrored body under a turned parent keeps its mirroring as it falls", async () => {
    const engine = await world([0, -10]);
    const parent = GameObject.create("parent");
    parent.transform!.rotation2D = 0.4;
    parent.transform!.scale.set(2, 1, 1);
    const node = GameObject.create("mirrored", { parent });
    node.transform!.scale.set(-1, 1, 1);
    node.transform!.rotation2D = -0.3;
    node.addBehavior(RigidBody2D);
    node.addBehavior(CircleCollider2D, { radius: 0.5 });
    const before = linear2D(node);
    steps(engine, 5);
    close(linear2D(node), before);
    engine.dispose();
  });

  it("a polygon's points, a box and a circle's centre on a mirrored, turned node are where its world matrix puts them", async () => {
    const engine = await world();
    for (const [sx, sy, angle] of [[-1, 1, 0], [-1.5, 0.75, 0.6], [1, -2, -1.1], [-0.8, -1.2, 2.5]]) {
      const node = GameObject.create("mirrored");
      node.transform!.position.set(3, -1, 0);
      node.transform!.scale.set(sx, sy, 1);
      node.transform!.rotation2D = angle;
      const poly = node.addBehavior(PolygonCollider2D, { points: TRIANGLE });
      poly.center.set(0.4, 0.3);
      engine.step(1 / 60);
      expectTriangleWhereMatrixPutsIt(poly);
      GameObject.destroy(node);
      engine.step(1 / 60);

      const other = GameObject.create("mirrored circle");
      other.transform!.position.set(-2, 2, 0);
      other.transform!.scale.set(sx, sy, 1);
      other.transform!.rotation2D = angle;
      const circle = other.addBehavior(CircleCollider2D, { radius: 0.5 });
      circle.center.set(1.5, 0.75);
      engine.step(1 / 60);
      const centre = worldPoint(other, 1.5, 0.75), r = 0.5 * Math.max(Math.abs(sx), Math.abs(sy));
      expectSurfaceAt(circle, [centre[0], centre[1] + r], [0, 1]);
      expectSurfaceAt(circle, [centre[0] - r, centre[1]], [-1, 0]);
      GameObject.destroy(other);
      engine.step(1 / 60);
    }
    engine.dispose();
  });

  it("a polygon on a child of a mirrored body is where the world matrix puts it, before and after the body moves", async () => {
    const engine = await world();
    const body = GameObject.create("body");
    body.transform!.scale.set(-1, 1, 1);
    body.transform!.rotation2D = 0.5;
    const rb = body.addBehavior(RigidBody2D);
    const child = GameObject.create("child", { parent: body });
    child.transform!.position.set(1.5, 0.5, 0);
    child.transform!.rotation2D = 0.3;
    const poly = child.addBehavior(PolygonCollider2D, { points: TRIANGLE });
    engine.step(1 / 60);
    expectTriangleWhereMatrixPutsIt(poly);
    rb.angularVelocity = 90;
    rb.velocity = new Vector2(1, 0.5);
    steps(engine, 20);
    rb.angularVelocity = 0;
    rb.velocity = new Vector2(0, 0);
    engine.step(1 / 60);
    expectTriangleWhereMatrixPutsIt(poly);
    engine.dispose();
  });

  it("a hinge on a mirrored body turns about the anchor where the world matrix puts it", async () => {
    const engine = await world([0, -10]);
    const node = GameObject.create("pendulum");
    node.transform!.position.set(0, 2, 0);
    node.transform!.scale.set(-1, 1, 1);
    node.addBehavior(RigidBody2D);
    node.addBehavior(BoxCollider2D, { size: new Vector2(0.5, 0.5) });
    const hinge = node.addBehavior(HingeJoint2D, { anchor: new Vector2(1, 0.5) });
    const anchor = worldPoint(node, hinge.anchor.x, hinge.anchor.y); // (-1, 2.5): the mirror puts it left
    close(anchor, [-1, 2.5]);
    steps(engine, 40);
    expect(Math.abs(node.transform!.rotation2D)).toBeGreaterThan(0.1); // it swung
    close(worldPoint(node, hinge.anchor.x, hinge.anchor.y), anchor, 2);
    engine.dispose();
  });
});
