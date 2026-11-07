// Stay events, child colliders that move relative to their body, and interpolation (ADR 0093), in 2D and 3D.
import { describe, expect, it } from "vitest";
import { Assets, BoxCollider, BoxCollider2D, Engine, GameBehavior, GameObject, Physics, Physics2D, RigidBody, RigidBody2D, SceneManager } from "../index";

const project = { physics: { gravity: [0, -10] as [number, number], layers: ["Default"] } };

async function setup(mode: "2d" | "3d") {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics: mode }, nodes: [] } }));
  const engine = await Engine.create({ headless: true, project });
  await SceneManager.load("s.json");
  return engine;
}

const steps = (engine: Engine, n: number) => {
  for (let i = 0; i < n; i++) engine.step(1 / 60);
};

class Counter extends GameBehavior {
  log: string[] = [];
  onCollisionEnter() { this.log.push("enter"); }
  onCollisionStay() { this.log.push("stay"); }
  onCollisionExit() { this.log.push("exit"); }
  onTriggerEnter() { this.log.push("tenter"); }
  onTriggerStay() { this.log.push("tstay"); }
  onTriggerExit() { this.log.push("texit"); }
}

describe("Stay events (ADR 0093)", () => {
  it("3D: onCollisionStay runs each step after Enter while touching, and stops after Exit", async () => {
    const engine = await setup("3d");
    const floor = GameObject.create("floor");
    floor.transform!.position.y = -1;
    floor.addBehavior(BoxCollider).size.set(20, 1, 20);
    const box = GameObject.create("box");
    box.transform!.position.y = 0;
    box.addBehavior(RigidBody);
    box.addBehavior(BoxCollider);
    const c = box.addBehavior(Counter);
    steps(engine, 60);
    expect(c.log[0]).toBe("enter");
    expect(c.log.filter((e) => e === "stay").length).toBeGreaterThan(30);
    expect(c.log.slice(1).every((e) => e === "stay")).toBe(true);
    box.transform!.position.y = 50; // teleported away
    steps(engine, 3);
    expect(c.log.at(-1)).toBe("exit");
    const n = c.log.length;
    steps(engine, 5);
    expect(c.log.length).toBe(n);
  });

  it("2D: onTriggerStay runs while overlapping a trigger", async () => {
    const engine = await setup("2d");
    const zone = GameObject.create("zone");
    zone.addBehavior(BoxCollider2D, { isTrigger: true }).size.set(4, 4);
    const ball = GameObject.create("ball");
    ball.addBehavior(RigidBody2D, { useGravity: false });
    ball.addBehavior(BoxCollider2D);
    const c = ball.addBehavior(Counter);
    steps(engine, 10);
    expect(c.log[0]).toBe("tenter");
    expect(c.log.filter((e) => e === "tstay").length).toBeGreaterThanOrEqual(7);
    GameObject.destroy(ball);
    steps(engine, 3); // a destroyed collider leaves no pair behind
  });
});

describe("child colliders follow their node (ADR 0093)", () => {
  it("3D: moving a child collider relative to its body moves the shape", async () => {
    const engine = await setup("3d");
    const body = GameObject.create("body");
    body.addBehavior(RigidBody, { bodyType: "kinematic" });
    const arm = GameObject.create("arm");
    arm.setParent(body);
    arm.addBehavior(BoxCollider);
    steps(engine, 2);
    expect(Physics.raycast({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 20)?.collider.node.name).toBe("arm");
    arm.transform!.position.x = 5;
    steps(engine, 2);
    expect(Physics.raycast({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 20)).toBeNull();
    expect(Physics.raycast({ x: 5, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 20)?.collider.node.name).toBe("arm");
  });

  it("2D: moving a child collider relative to its body moves the shape", async () => {
    const engine = await setup("2d");
    const body = GameObject.create("body");
    body.addBehavior(RigidBody2D, { bodyType: "kinematic" });
    const arm = GameObject.create("arm");
    arm.setParent(body);
    arm.addBehavior(BoxCollider2D);
    steps(engine, 2);
    expect(Physics2D.raycast({ x: 0, y: 10 }, { x: 0, y: -1 }, 20)?.collider.node.name).toBe("arm");
    arm.transform!.position.x = 5;
    steps(engine, 2);
    expect(Physics2D.raycast({ x: 0, y: 10 }, { x: 0, y: -1 }, 20)).toBeNull();
    expect(Physics2D.raycast({ x: 5, y: 10 }, { x: 0, y: -1 }, 20)?.collider.node.name).toBe("arm");
  });
});

describe("interpolation (ADR 0093)", () => {
  it("3D: shows a falling body between its last two steps, and restores the simulated pose before the next step", async () => {
    const engine = await setup("3d");
    const box = GameObject.create("box");
    box.transform!.position.y = 10;
    box.addBehavior(RigidBody);
    box.addBehavior(BoxCollider);
    steps(engine, 5);
    const sim = box.transform!.position.y;
    const world = engine.world;
    world.physics3D!.interpolate(0);
    const prev = box.transform!.position.y;
    expect(prev).toBeGreaterThan(sim); // one step behind (higher: it's falling)
    world.physics3D!.interpolate(0.5);
    expect(box.transform!.position.y).toBeCloseTo((prev + sim) / 2, 5);
    world.physics3D!.restoreInterpolated();
    expect(box.transform!.position.y).toBeCloseTo(sim, 5);
    // The interpolated pose was not taken for a teleport: the body keeps falling smoothly.
    world.physics3D!.interpolate(0.25);
    steps(engine, 1);
    expect(box.transform!.position.y).toBeLessThan(sim);
    expect(sim - box.transform!.position.y).toBeLessThan(0.1);
  });

  it("2D: a script's move wins over interpolation; interpolate=false never blends", async () => {
    const engine = await setup("2d");
    const a = GameObject.create("a");
    a.transform!.position.y = 10;
    a.addBehavior(RigidBody2D);
    a.addBehavior(BoxCollider2D);
    const b = GameObject.create("b");
    b.transform!.position.set(5, 10, 0);
    b.addBehavior(RigidBody2D, { interpolate: false });
    b.addBehavior(BoxCollider2D);
    steps(engine, 5);
    const simB = b.transform!.position.y;
    engine.world.physics2D!.interpolate(0);
    expect(b.transform!.position.y).toBe(simB);
    expect(a.transform!.position.y).toBeGreaterThan(simB);
    a.transform!.position.y = 100; // a script teleports it
    engine.world.physics2D!.interpolate(0.5);
    expect(a.transform!.position.y).toBe(100);
    steps(engine, 1);
    expect(a.transform!.position.y).toBeGreaterThan(99);
  });
});
