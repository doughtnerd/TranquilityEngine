import { describe, expect, it } from "vitest";
import {
  Assets,
  BoxCollider2D,
  CircleCollider2D,
  Engine,
  GameBehavior,
  GameObject,
  Physics2D,
  RigidBody2D,
  SceneManager,
  TriggerEvents2D,
  type Collider2D,
  type Collision2D,
} from "../index";

const events: string[] = [];

class Probe extends GameBehavior {
  onTriggerEnter(other: Collider2D) { events.push(`trigger:${other.node.name}`); }
  onCollisionEnter(c: Collision2D) { events.push(`collision:${c.collider.node.name}`); }
}

/** Reads the trigger buffer from a script, as game code would (ADR 0017). */
class BufferRecorder extends GameBehavior {
  seen: string[] = [];
  update() {
    for (const e of TriggerEvents2D.read()) {
      const [a, b] = [e.a.node.name, e.b.node.name].sort();
      this.seen.push(`${a}/${b}:${e.started}`);
    }
  }
}

const project = {
  physics: {
    gravity: [0, -10] as [number, number],
    layers: ["Default", "Player", "Wall", "Ghost"],
    collisionMatrix: { Player: ["Wall"] },
  },
};

async function setup() {
  events.length = 0;
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics: "2d" }, nodes: [] } }));
  const engine = await Engine.create({ headless: true, project });
  await SceneManager.load("s.json");
  return engine;
}

function steps(engine: Engine, n: number) {
  for (let i = 0; i < n; i++) engine.step(1 / 60);
}

describe("2D physics on Rapier (ADR 0005)", () => {
  it("dynamic bodies fall and write back to the Transform", async () => {
    const engine = await setup();
    const ball = GameObject.create("ball");
    ball.addBehavior(RigidBody2D);
    ball.addBehavior(CircleCollider2D, { radius: 0.5 });
    steps(engine, 60);
    // ~ -0.5 * 10 * 1^2 = -5 after one second
    expect(ball.transform!.position.y).toBeLessThan(-4.5);
    expect(ball.transform!.position.y).toBeGreaterThan(-5.5);
    expect(ball.getBehavior(RigidBody2D)!.velocity.y).toBeCloseTo(-10, 0);
  });

  it("collides with static colliders on matching layers and reports collisions", async () => {
    const engine = await setup();
    const floor = GameObject.create("floor");
    floor.transform!.position.y = -2;
    floor.addBehavior(BoxCollider2D, { layer: "Wall" }).size.set(10, 1);
    const ball = GameObject.create("ball");
    ball.addBehavior(RigidBody2D);
    ball.addBehavior(CircleCollider2D, { radius: 0.5, layer: "Player" });
    ball.addBehavior(Probe);
    steps(engine, 90);
    expect(ball.transform!.position.y).toBeCloseTo(-1, 1);
    expect(events).toContain("collision:floor");
  });

  it("ignores layers the collision matrix excludes", async () => {
    const engine = await setup();
    const floor = GameObject.create("floor");
    floor.transform!.position.y = -2;
    floor.addBehavior(BoxCollider2D, { layer: "Ghost" }).size.set(10, 1);
    const ball = GameObject.create("ball");
    ball.addBehavior(RigidBody2D);
    ball.addBehavior(CircleCollider2D, { radius: 0.5, layer: "Player" });
    steps(engine, 90);
    expect(ball.transform!.position.y).toBeLessThan(-5);
  });

  it("reports triggers to scripts and buffers, and follows moved static triggers", async () => {
    const engine = await setup();
    const ball = GameObject.create("ball");
    const rb = ball.addBehavior(RigidBody2D, { useGravity: false });
    ball.addBehavior(CircleCollider2D, { radius: 0.5, layer: "Player" });
    ball.addBehavior(Probe);
    const recorder = GameObject.create("recorder").addBehavior(BufferRecorder);
    const zone = GameObject.create("zone");
    zone.transform!.position.x = 5;
    zone.addBehavior(BoxCollider2D, { isTrigger: true, layer: "Wall" });
    steps(engine, 5);
    expect(events).toEqual([]);
    zone.transform!.position.x = 0; // move the static trigger onto the ball
    steps(engine, 5);
    expect(events).toEqual(["trigger:zone"]);
    expect(recorder.seen).toEqual(["ball/zone:true"]);
    expect(TriggerEvents2D.read()).toHaveLength(0); // cleared at end of frame
    expect(rb.velocity.y).toBe(0); // triggers don't push bodies
  });

  it("teleports a dynamic body when a script moves its Transform", async () => {
    const engine = await setup();
    const ball = GameObject.create("ball");
    ball.addBehavior(RigidBody2D, { useGravity: false });
    ball.addBehavior(CircleCollider2D);
    steps(engine, 2);
    ball.transform!.position.set(7, 3, 0);
    steps(engine, 2);
    expect(ball.transform!.position.x).toBeCloseTo(7);
    expect(ball.transform!.position.y).toBeCloseTo(3);
  });

  it("raycasts against colliders", async () => {
    const engine = await setup();
    const wall = GameObject.create("wall");
    wall.transform!.position.x = 4;
    wall.addBehavior(BoxCollider2D, { layer: "Wall" });
    steps(engine, 1);
    const hit = Physics2D.raycast({ x: 0, y: 0 }, { x: 1, y: 0 }, 100);
    expect(hit?.collider.node.name).toBe("wall");
    expect(hit?.distance).toBeCloseTo(3.5);
  });
});
