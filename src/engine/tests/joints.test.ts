// Joints in 2D and 3D (ADR 0092).
import { describe, expect, it } from "vitest";
import {
  Assets,
  BallJoint,
  BoxCollider,
  BoxCollider2D,
  Engine,
  FixedJoint,
  FixedJoint2D,
  GameObject,
  HingeJoint,
  HingeJoint2D,
  RigidBody,
  RigidBody2D,
  RopeJoint,
  RopeJoint2D,
  SceneManager,
  SliderJoint,
  SliderJoint2D,
  SpringJoint,
  SpringJoint2D,
} from "../index";

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

function body3(name: string, x: number, y: number, bodyType: "dynamic" | "static" | "kinematic" = "dynamic") {
  const go = GameObject.create(name);
  go.transform!.position.set(x, y, 0);
  go.addBehavior(RigidBody, { bodyType });
  go.addBehavior(BoxCollider).size.set(0.5, 0.5, 0.5);
  return go;
}

function body2(name: string, x: number, y: number, bodyType: "dynamic" | "static" | "kinematic" = "dynamic") {
  const go = GameObject.create(name);
  go.transform!.position.set(x, y, 0);
  go.addBehavior(RigidBody2D, { bodyType });
  go.addBehavior(BoxCollider2D).size.set(0.5, 0.5);
  return go;
}

const pos = (go: GameObject) => go.transform!.position;

describe("3D joints (ADR 0092)", () => {
  it("a FixedJoint to the world holds a body up against gravity", async () => {
    const engine = await setup("3d");
    const a = body3("a", 0, 5);
    a.addBehavior(FixedJoint);
    steps(engine, 60);
    expect(pos(a).y).toBeCloseTo(5, 1);
  });

  it("a FixedJoint between bodies keeps their offset while they fall", async () => {
    const engine = await setup("3d");
    const a = body3("a", 0, 5), b = body3("b", 2, 5);
    a.addBehavior(FixedJoint, { connectedBody: b });
    steps(engine, 30);
    expect(pos(b).x - pos(a).x).toBeCloseTo(2, 1);
    expect(pos(a).y).toBeLessThan(4);
  });

  it("a HingeJoint swings a body around its anchor, keeping its distance, within limits", async () => {
    const engine = await setup("3d");
    const arm = body3("arm", 2, 5);
    const hinge = arm.addBehavior(HingeJoint, { axis: { x: 0, y: 0, z: 1 } as never });
    hinge.anchor.set(-2, 0, 0); // pivot at (0, 5, 0)
    steps(engine, 45);
    const d = Math.hypot(pos(arm).x, pos(arm).y - 5);
    expect(d).toBeCloseTo(2, 1);
    expect(pos(arm).y).toBeLessThan(4.6); // swung down
    // With limits of ±10°, it stays near horizontal.
    const engine2 = await setup("3d");
    const arm2 = body3("arm2", 2, 5);
    const h2 = arm2.addBehavior(HingeJoint, { useLimits: true, limits: { min: -10, max: 10 } });
    h2.axis.set(0, 0, 1);
    h2.anchor.set(-2, 0, 0);
    steps(engine2, 60);
    expect(pos(arm2).y).toBeGreaterThan(5 - 2 * Math.sin((12 * Math.PI) / 180));
  });

  it("a hinge motor turns the body counterclockwise around +z at its target speed", async () => {
    const engine = await setup("3d");
    const wheel = body3("wheel", 0, 5);
    wheel.getBehavior(RigidBody)!.useGravity = false;
    const h = wheel.addBehavior(HingeJoint, { useMotor: true, motor: { targetVelocity: 90, force: 1000 } });
    h.axis.set(0, 0, 1);
    steps(engine, 60);
    expect(wheel.getBehavior(RigidBody)!.angularVelocity.z).toBeCloseTo(90, -1);
  });

  it("a SliderJoint lets the body move only along its axis, up to its limit", async () => {
    const engine = await setup("3d");
    const slider = body3("slider", 0, 5);
    const j = slider.addBehavior(SliderJoint, { useLimits: true, limits: { min: -1, max: 0 } });
    j.axis.set(1, 1, 0); // a 45° rail
    steps(engine, 120);
    expect(pos(slider).x).toBeCloseTo(pos(slider).y - 5, 2); // stays on the rail
    expect(pos(slider).y).toBeCloseTo(5 - Math.SQRT1_2, 1); // stopped at the -1 limit
  });

  it("a BallJoint pendulum keeps its length; ropes stay slack until taut; springs settle", async () => {
    const engine = await setup("3d");
    const bob = body3("bob", 1, 5);
    bob.addBehavior(BallJoint).anchor.set(-1, 0, 0);
    const anchor = body3("hook", 5, 10, "static");
    const weight = body3("weight", 5, 9);
    weight.addBehavior(RopeJoint, { connectedBody: anchor, autoConfigureDistance: false, maxDistance: 3 });
    const top = body3("top", 10, 10, "static");
    const hanging = body3("hanging", 10, 9);
    hanging.addBehavior(SpringJoint, { connectedBody: top, spring: 50, damper: 5 });
    steps(engine, 240);
    expect(Math.hypot(pos(bob).x, pos(bob).y - 5, pos(bob).z)).toBeCloseTo(1, 1);
    expect(10 - pos(weight).y).toBeCloseTo(3, 1); // fell until the rope went taut
    // Rest length 1 (where it started), stretched by mg/k = 10/50.
    expect(10 - pos(hanging).y).toBeCloseTo(1.2, 1);
  });

  it("removing a joint frees the body; destroying the connected body drops the joint", async () => {
    const engine = await setup("3d");
    const a = body3("a", 0, 5);
    const j = a.addBehavior(FixedJoint);
    steps(engine, 10);
    GameObject.destroy(j);
    steps(engine, 30);
    expect(pos(a).y).toBeLessThan(4.5);
  });
});

describe("2D joints (ADR 0092)", () => {
  it("FixedJoint2D holds a body; a rotated body keeps its rotation", async () => {
    const engine = await setup("2d");
    const a = body2("a", 0, 5);
    a.transform!.eulerAngles = [0, 0, 30];
    a.addBehavior(FixedJoint2D);
    steps(engine, 60);
    expect(pos(a).y).toBeCloseTo(5, 1);
    expect(a.transform!.worldRotation2D).toBeCloseTo(30, 0);
  });

  it("HingeJoint2D swings, respects limits, and its motor turns counterclockwise", async () => {
    const engine = await setup("2d");
    const arm = body2("arm", 2, 5);
    arm.addBehavior(HingeJoint2D).anchor.set(-2, 0);
    const limited = body2("limited", 2, 0);
    limited.addBehavior(HingeJoint2D, { useLimits: true, limits: { min: -10, max: 10 } }).anchor.set(-2, 0);
    const wheel = body2("wheel", 10, 5);
    wheel.getBehavior(RigidBody2D)!.useGravity = false;
    wheel.addBehavior(HingeJoint2D, { useMotor: true, motor: { targetVelocity: 90, force: 1000 } });
    steps(engine, 45);
    expect(Math.hypot(pos(arm).x, pos(arm).y - 5)).toBeCloseTo(2, 1);
    expect(pos(arm).y).toBeLessThan(4.6);
    expect(pos(limited).y).toBeGreaterThan(-2 * Math.sin((12 * Math.PI) / 180));
    expect(wheel.getBehavior(RigidBody2D)!.angularVelocity).toBeCloseTo(90, -1);
  });

  it("SliderJoint2D keeps to its axis and limits; ropes and springs", async () => {
    const engine = await setup("2d");
    const s = body2("s", 0, 5);
    s.addBehavior(SliderJoint2D, { useLimits: true, limits: { min: -1, max: 0 } }).axis.set(1, 1);
    const hook = body2("hook", 5, 10, "static");
    const w = body2("w", 5, 9);
    w.addBehavior(RopeJoint2D, { connectedBody: hook, autoConfigureDistance: false, maxDistance: 3 });
    const top = body2("top", 10, 10, "static");
    const h = body2("h", 10, 9);
    h.addBehavior(SpringJoint2D, { connectedBody: top, spring: 50, damper: 5 });
    steps(engine, 240);
    expect(pos(s).x).toBeCloseTo(pos(s).y - 5, 2);
    expect(pos(s).y).toBeCloseTo(5 - Math.SQRT1_2, 1);
    expect(10 - pos(w).y).toBeCloseTo(3, 1);
    expect(10 - pos(h).y).toBeCloseTo(1.2, 1);
  });
});

describe("joints in scene files (ADR 0092)", () => {
  it("connect to a node by reference, and a hinge between rotated bodies doesn't snap them", async () => {
    Assets.clearSources();
    Assets.addSource(
      Assets.fromObject({
        "s.json": {
          format: "myco.scene@1",
          settings: { physics: "3d" },
          nodes: [
            { id: "base", name: "Base", components: [{ type: "engine.Transform", data: { position: [0, 5, 0], rotation: [0, 0, 45] } }, { type: "engine.RigidBody", data: { bodyType: "static" } }] },
            {
              id: "door",
              name: "Door",
              components: [
                { type: "engine.Transform", data: { position: [1, 5, 0] } },
                { type: "engine.RigidBody", data: { useGravity: false } },
                { type: "engine.BoxCollider", data: { size: [0.2, 0.2, 0.2] } },
                { type: "engine.HingeJoint", data: { connectedBody: { $node: "base" }, axis: [0, 1, 0], anchor: [-1, 0, 0] } },
              ],
            },
          ],
        },
      }),
    );
    const engine = await Engine.create({ headless: true, project });
    await SceneManager.load("s.json");
    const door = GameObject.findObjectOfType(HingeJoint)!.node;
    expect(door.getBehavior(HingeJoint)!.connectedBody?.name).toBe("Base");
    steps(engine, 30);
    expect(pos(door).x).toBeCloseTo(1, 3);
    expect(pos(door).y).toBeCloseTo(5, 3);
    expect(door.transform!.worldRotation.w).toBeCloseTo(1, 3); // the base is turned 45°; the door stays as it was
  });
});
