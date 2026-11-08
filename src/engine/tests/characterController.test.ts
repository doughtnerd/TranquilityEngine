// CharacterController and CharacterController2D on Rapier's kinematic character controller (ADR 0091).
import { describe, expect, it } from "vitest";
import {
  Assets,
  BoxCollider,
  BoxCollider2D,
  CharacterController,
  CharacterController2D,
  Engine,
  GameBehavior,
  GameObject,
  Physics,
  RigidBody,
  RigidBody2D,
  SceneManager,
  type ControllerColliderHit,
} from "../../myco";

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

function box3(name: string, pos: [number, number, number], size: [number, number, number], rotZ = 0) {
  const go = GameObject.create(name);
  go.transform!.position.set(...pos);
  if (rotZ) go.transform!.eulerAngles = [0, 0, rotZ];
  go.addBehavior(BoxCollider).size.set(...size);
  return go;
}

class HitLog extends GameBehavior {
  hits: string[] = [];
  onControllerColliderHit(hit: ControllerColliderHit) { this.hits.push(hit.collider.node.name); }
}

describe("CharacterController (ADR 0091)", () => {
  it("falls with simpleMove, lands, is grounded, and walks", async () => {
    const engine = await setup("3d");
    box3("floor", [0, -0.5, 0], [40, 1, 40]);
    const player = GameObject.create("player");
    player.transform!.position.y = 3;
    const cc = player.addBehavior(CharacterController); // capsule 2 tall, centre at the node: feet at y - 1
    steps(engine, 1);
    for (let i = 0; i < 120; i++) {
      cc.simpleMove({ x: 0, y: 0, z: 0 });
      steps(engine, 1);
    }
    expect(cc.isGrounded).toBe(true);
    expect(player.transform!.position.y).toBeCloseTo(1, 1);
    const x0 = player.transform!.position.x;
    for (let i = 0; i < 60; i++) {
      cc.simpleMove({ x: 2, y: 0, z: 0 });
      steps(engine, 1);
    }
    expect(player.transform!.position.x - x0).toBeCloseTo(2, 1);
    expect(cc.isGrounded).toBe(true);
    expect(cc.velocity.x).toBeCloseTo(2, 1);
  });

  it("stops at walls (sides), reports hits, and climbs steps but not tall ledges", async () => {
    const engine = await setup("3d");
    box3("floor", [0, -0.5, 0], [40, 1, 40]);
    box3("wall", [3, 2, 0], [1, 4, 10]);
    box3("step", [-3, 0.1, 0], [2, 0.2, 10]); // 0.2 high: under stepOffset 0.3
    const player = GameObject.create("player");
    player.transform!.position.y = 1.05;
    const cc = player.addBehavior(CharacterController);
    const log = player.addBehavior(HitLog);
    steps(engine, 1);
    for (let i = 0; i < 60; i++) {
      cc.move({ x: 0.1, y: -0.05, z: 0 });
      steps(engine, 1);
    }
    expect(player.transform!.position.x).toBeLessThan(2.5 - 0.5 + 0.05); // wall face at 2.5, radius 0.5
    expect(cc.collisionFlags.sides).toBe(true);
    expect(log.hits).toContain("wall");
    for (let i = 0; i < 45; i++) {
      cc.move({ x: -0.1, y: -0.05, z: 0 });
      steps(engine, 1);
    }
    expect(player.transform!.position.x).toBeLessThan(-2.1);
    expect(player.transform!.position.y).toBeGreaterThan(1.15); // up on the step
  });

  it("walks up gentle slopes but not steep ones", async () => {
    const engine = await setup("3d");
    box3("floor", [0, -0.5, 0], [40, 1, 40]);
    box3("gentle", [5, 0, 0], [6, 0.2, 6], 20);
    box3("steep", [-5, 0, 0], [6, 0.2, 6], -70);
    const player = GameObject.create("player");
    player.transform!.position.set(1, 1.05, 0);
    const cc = player.addBehavior(CharacterController);
    steps(engine, 1);
    for (let i = 0; i < 100; i++) {
      cc.move({ x: 0.05, y: -0.05, z: 0 });
      steps(engine, 1);
    }
    expect(player.transform!.position.x).toBeGreaterThan(5);
    expect(player.transform!.position.y).toBeGreaterThan(1.2); // up the 20° slope
    player.transform!.position.set(-1, 1.05, 0);
    for (let i = 0; i < 100; i++) {
      cc.move({ x: -0.05, y: -0.05, z: 0 });
      steps(engine, 1);
    }
    expect(player.transform!.position.y).toBeLessThan(1.5); // the 70° slope is a wall
    expect(player.transform!.position.x).toBeGreaterThan(-5); // stopped against it
  });

  it("pushes dynamic bodies when pushBodies is on", async () => {
    const engine = await setup("3d");
    box3("floor", [0, -0.5, 0], [40, 1, 40]);
    const crate = box3("crate", [2, 0.5, 0], [1, 1, 1]);
    crate.addBehavior(RigidBody, { mass: 0.5 });
    const player = GameObject.create("player");
    player.transform!.position.y = 1.05;
    const cc = player.addBehavior(CharacterController, { mass: 10 });
    steps(engine, 10);
    for (let i = 0; i < 60; i++) {
      cc.move({ x: 0.08, y: -0.05, z: 0 });
      steps(engine, 1);
    }
    expect(crate.transform!.position.x).toBeGreaterThan(2.5);
    expect(crate.transform!.position.x).toBeLessThan(8); // pushed along, not flung
    expect(Math.abs(crate.transform!.position.y - 0.5)).toBeLessThan(0.3);
  });

  it("is hit by raycasts and enters triggers", async () => {
    const engine = await setup("3d");
    const zone = box3("zone", [0, 0, 0], [4, 4, 4]);
    zone.getBehavior(BoxCollider)!.isTrigger = true;
    const entered: string[] = [];
    zone.addBehavior(class extends GameBehavior { onTriggerEnter(o: { node: { name: string } }) { entered.push(o.node.name); } });
    const player = GameObject.create("player");
    player.transform!.position.x = 10;
    const cc = player.addBehavior(CharacterController);
    steps(engine, 2);
    expect(Physics.raycast({ x: 10, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 20)?.collider).toBe(cc);
    cc.move({ x: -10, y: 0, z: 0 }); // triggers don't block
    expect(player.transform!.position.x).toBeCloseTo(0, 3);
    steps(engine, 2);
    expect(entered).toEqual(["player"]);
  });
});

describe("CharacterController2D (ADR 0091)", () => {
  it("lands on the ground, walks, and stops at walls", async () => {
    const engine = await setup("2d");
    const floor = GameObject.create("floor");
    floor.transform!.position.y = -0.5;
    floor.addBehavior(BoxCollider2D).size.set(40, 1);
    const wall = GameObject.create("wall");
    wall.transform!.position.set(3, 2, 0);
    wall.addBehavior(BoxCollider2D).size.set(1, 4);
    const player = GameObject.create("player");
    player.transform!.position.y = 3;
    const cc = player.addBehavior(CharacterController2D);
    steps(engine, 1);
    for (let i = 0; i < 120; i++) {
      cc.simpleMove({ x: 0, y: 0 });
      steps(engine, 1);
    }
    expect(cc.isGrounded).toBe(true);
    expect(player.transform!.position.y).toBeCloseTo(1, 1);
    for (let i = 0; i < 120; i++) {
      cc.simpleMove({ x: 3, y: 0 });
      steps(engine, 1);
    }
    expect(player.transform!.position.x).toBeLessThan(2.05);
    expect(player.transform!.position.x).toBeGreaterThan(1.8);
    expect(cc.collisionFlags.sides).toBe(true);
  });
});

describe("moving platforms (ADR 0091)", () => {
  it("3D: a controller standing on a kinematic platform rides it sideways and up", async () => {
    const engine = await setup("3d");
    const platform = box3("platform", [0, -0.5, 0], [4, 1, 4]);
    platform.addBehavior(RigidBody, { bodyType: "kinematic" });
    const player = GameObject.create("player");
    player.transform!.position.y = 1.05;
    const cc = player.addBehavior(CharacterController);
    const stay = GameObject.create("still");
    stay.transform!.position.set(20, 1.05, 0);
    const still = stay.addBehavior(CharacterController, { moveWithPlatforms: false });
    box3("ground", [20, -0.5, 0], [4, 1, 4]);
    steps(engine, 1);
    for (let i = 0; i < 30; i++) {
      cc.simpleMove({ x: 0, y: 0, z: 0 });
      still.simpleMove({ x: 0, y: 0, z: 0 });
      steps(engine, 1);
    }
    expect(cc.isGrounded).toBe(true);
    for (let i = 0; i < 60; i++) {
      platform.transform!.position.x += 1 / 60; // 1 unit/s sideways
      platform.transform!.position.y += 0.5 / 60; // and 0.5 up
      cc.simpleMove({ x: 0, y: 0, z: 0 });
      steps(engine, 1);
    }
    expect(player.transform!.position.x).toBeCloseTo(platform.transform!.position.x, 1);
    expect(player.transform!.position.y).toBeCloseTo(platform.transform!.position.y + 1.5, 1);
    expect(stay.transform!.position.x).toBeCloseTo(20, 3);
  });

  it("2D: a controller rides a kinematic platform", async () => {
    const engine = await setup("2d");
    const platform = GameObject.create("platform");
    platform.transform!.position.y = -0.5;
    platform.addBehavior(RigidBody2D, { bodyType: "kinematic" });
    platform.addBehavior(BoxCollider2D).size.set(4, 1);
    const player = GameObject.create("player");
    player.transform!.position.y = 1.05;
    const cc = player.addBehavior(CharacterController2D);
    steps(engine, 1);
    for (let i = 0; i < 30; i++) {
      cc.simpleMove({ x: 0, y: 0 });
      steps(engine, 1);
    }
    for (let i = 0; i < 60; i++) {
      platform.transform!.position.x -= 1 / 60;
      cc.simpleMove({ x: 0, y: 0 });
      steps(engine, 1);
    }
    expect(player.transform!.position.x).toBeCloseTo(-1, 1);
    expect(cc.isGrounded).toBe(true);
  });
});
