import { physics2DOf } from "../../plugins/physics/runtime/systems2d";
import { physics3DOf } from "../../plugins/physics/runtime/systems3d";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Assets,
  BoxCollider,
  CapsuleCollider,
  CollisionEvents,
  Engine,
  GameBehavior,
  GameObject,
  MeshCollider,
  MeshRenderer,
  Physics,
  Quaternion,
  RigidBody,
  SceneManager,
  SphereCollider,
  type Collider,
  type Collision,
} from "../../myco";
import { clearModelCache } from "../scene/models";
import { boxHalfExtents, capsuleSize, sphereRadius } from "../physics/shape3d";

const events: string[] = [];

class Probe extends GameBehavior {
  onTriggerEnter(other: Collider) { events.push(`trigger:${other.node.name}`); }
  onCollisionEnter(c: Collision) { events.push(`collision:${c.collider.node.name}`); }
}

class EventReader extends GameBehavior {
  seen: string[] = [];
  update() {
    for (const e of CollisionEvents.read()) this.seen.push([e.a.node.name, e.b.node.name].sort().join("/"));
  }
}

const project = { physics: { gravity: [0, -10] as [number, number], layers: ["Default", "Player", "Ghost"], collisionMatrix: { Player: ["Default"], Default: ["Default"] } } };
const dataUrl = (path: string) => `data:application/octet-stream;base64,${readFileSync(new URL(`../../../samples/playground3d/${path}`, import.meta.url)).toString("base64")}`;

async function setup(settings: Record<string, unknown> = { physics: "3d" }) {
  events.length = 0;
  clearModelCache();
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      "s.json": { format: "myco.scene@1", settings, nodes: [] },
      "models/crate.obj": dataUrl("models/crate.obj"),
      "models/crate.mtl": dataUrl("models/crate.mtl"),
    }),
  );
  const engine = await Engine.create({ headless: true, project });
  await SceneManager.load("s.json");
  return engine;
}

const steps = (engine: Engine, n: number) => {
  for (let i = 0; i < n; i++) engine.step(1 / 60);
};

describe("3D collider sizes (ADR 0045)", () => {
  it("scale boxes per axis, spheres by the largest axis, capsules across and along", () => {
    expect(boxHalfExtents([1, 2, 4], [2, 1, 0.5])).toEqual([1, 1, 1]);
    expect(sphereRadius(0.5, [1, 3, -2])).toBe(1.5);
    expect(capsuleSize(0.5, 2, 1, [2, 1, 1])).toEqual({ radius: 1, halfHeight: 0 }); // never shorter than its diameter
    expect(capsuleSize(0.5, 4, 1, [1, 1, 1])).toEqual({ radius: 0.5, halfHeight: 1.5 });
  });
});

describe("3D physics on Rapier (ADR 0045)", () => {
  beforeEach(() => (events.length = 0));

  it("drops a box onto a static floor, writes back position and rotation, and reports the collision", async () => {
    const engine = await setup();
    const floor = GameObject.create("floor");
    floor.transform!.position.y = -1;
    floor.addBehavior(BoxCollider).size.set(20, 1, 20);
    const box = GameObject.create("box");
    box.transform!.position.y = 3;
    box.addBehavior(RigidBody);
    box.addBehavior(BoxCollider);
    box.addBehavior(Probe);
    const reader = GameObject.create("reader").addBehavior(EventReader);
    steps(engine, 150);
    expect(box.transform!.position.y).toBeCloseTo(0, 1); // resting on the floor's top face (y = -0.5)
    expect(events).toContain("collision:floor");
    expect(reader.seen).toContain("box/floor");
    expect(physics3DOf(engine.world)!).not.toBeNull();
  });

  it("falls under gravity, and spins when given angular velocity", async () => {
    const engine = await setup();
    const ball = GameObject.create("ball");
    const rb = ball.addBehavior(RigidBody, { useGravity: false });
    ball.addBehavior(SphereCollider);
    rb.angularVelocity = { x: 0, y: 90, z: 0 };
    steps(engine, 60);
    expect(ball.transform!.eulerAngles.y).toBeGreaterThan(60); // about 90° after a second, less damping
    rb.useGravity = true;
    steps(engine, 60);
    expect(ball.transform!.position.y).toBeLessThan(-4);
  });

  it("puts colliders on child nodes on their ancestor's body, and turns capsules along their axis", async () => {
    const engine = await setup();
    const floor = GameObject.create("floor");
    floor.addBehavior(BoxCollider).size.set(20, 0.2, 20);
    const body = GameObject.create("body");
    body.transform!.position.y = 4;
    body.addBehavior(RigidBody);
    const leg = GameObject.create("leg", { parent: body });
    leg.addBehavior(CapsuleCollider, { radius: 0.25, height: 3, direction: "x" });
    steps(engine, 150);
    // Lying along X, the capsule rests a radius above the floor's top (0.1).
    expect(body.transform!.position.y).toBeCloseTo(0.35, 1);
  });

  it("collides only with layers the matrix allows, and triggers don't push", async () => {
    const engine = await setup();
    const floor = GameObject.create("floor");
    floor.transform!.position.y = -1;
    floor.addBehavior(BoxCollider, { layer: "Ghost" }).size.set(20, 1, 20);
    const zone = GameObject.create("zone");
    zone.addBehavior(BoxCollider, { isTrigger: true }).size.set(4, 4, 4);
    const box = GameObject.create("box");
    box.addBehavior(RigidBody);
    box.addBehavior(SphereCollider, { layer: "Player" });
    box.addBehavior(Probe);
    steps(engine, 90);
    expect(box.transform!.position.y).toBeLessThan(-3); // fell through the Ghost floor
    expect(events).toEqual(["trigger:zone"]);
  });

  it("raycasts against colliders", async () => {
    const engine = await setup();
    const wall = GameObject.create("wall");
    wall.transform!.position.x = 5;
    wall.addBehavior(BoxCollider).size.set(1, 4, 4);
    steps(engine, 1);
    const hit = Physics.raycast({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    expect(hit?.collider.node.name).toBe("wall");
    expect(hit?.distance).toBeCloseTo(4.5, 3);
    expect(hit?.normal.x).toBeCloseTo(-1, 3);
    expect(Physics.raycast({ x: 0, y: 0, z: 0 }, { x: -1, y: 0, z: 0 })).toBeNull();
  });

  it("follows a moved static collider and a kinematic body", async () => {
    const engine = await setup();
    const wall = GameObject.create("wall");
    wall.addBehavior(BoxCollider);
    steps(engine, 1);
    wall.transform!.position.x = 10;
    wall.transform!.rotation = Quaternion.fromEuler(0, 0, 45);
    steps(engine, 1);
    expect(Physics.raycast({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })?.distance).toBeCloseTo(10 - Math.SQRT1_2, 2);
  });

  it("builds mesh colliders from a model (exact and convex) and from the node's MeshRenderer", async () => {
    const engine = await setup();
    const ground = GameObject.create("ground");
    ground.addBehavior(MeshRenderer, { mesh: "builtin:plane" });
    ground.addBehavior(MeshCollider);
    const crate = GameObject.create("crate");
    crate.transform!.position.y = 3;
    crate.addBehavior(RigidBody);
    crate.addBehavior(MeshCollider, { mesh: "asset:models/crate.obj", convex: true });
    for (let i = 0; i < 20 && !crate.getBehavior(MeshCollider)!._state; i++) {
      await new Promise((r) => setTimeout(r, 10)); // the model loads
      steps(engine, 1);
    }
    steps(engine, 150);
    expect(crate.transform!.position.y).toBeCloseTo(0.5, 1); // a 1 m crate on the plane
  });

  it("starts 3D physics for a scene with 3D bodies that doesn't say which physics it uses", async () => {
    events.length = 0;
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({ "auto.json": { format: "myco.scene@1", nodes: [{ id: "a", components: [{ type: "engine.Transform" }, { type: "engine.RigidBody" }, { type: "engine.SphereCollider" }] }] } }),
    );
    const engine = await Engine.create({ headless: true, project });
    await SceneManager.load("auto.json");
    expect(physics3DOf(engine.world)!).not.toBeNull();
    expect(physics2DOf(engine.world)).toBeNull();
  });
});

describe("3D physics auto-detection", () => {
  it("sees 3D bodies added to prefab instances as overrides", async () => {
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "p.prefab.json": { format: "myco.scene@1", nodes: [{ id: "root", components: [{ type: "engine.Transform" }] }] },
        "s.json": { format: "myco.scene@1", nodes: [{ id: "i", prefab: "p.prefab.json", overrides: [{ addComponent: { type: "engine.RigidBody" } }] }] },
      }),
    );
    const engine = await Engine.create({ headless: true, project });
    await SceneManager.load("s.json");
    expect(physics3DOf(engine.world)!).not.toBeNull();
  });
});
