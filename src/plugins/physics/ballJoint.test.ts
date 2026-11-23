// Ball joints (ADR 0375): elliptical swing limits and the target-rotation drive, through the engine on the Rapier backend.
import { describe, expect, it } from "vitest";
import { Assets, BallJoint, BoxCollider, Engine, GameObject, Quaternion, RigidBody, SceneManager } from "../../myco";
import type { ComponentInit } from "../../engine/scene/GameObject";

const project = { physics: { gravity: [0, -10] as [number, number], layers: ["Default"] } };

async function setup() {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@5", settings: { physics: "3d" }, nodes: [] } }));
  const engine = await Engine.create({ headless: true, project });
  await SceneManager.load("s.json");
  return engine;
}

const steps = (engine: Engine, n: number) => {
  for (let i = 0; i < n; i++) engine.step(1 / 60);
};

/** A dynamic box at the origin, pinned to the world by a ball joint at its centre. */
function pinned(init: ComponentInit<BallJoint> = {}, gravity = false) {
  const go = GameObject.create("ball");
  go.addBehavior(RigidBody).useGravity = gravity;
  go.addBehavior(BoxCollider).size.set(0.5, 0.5, 0.5);
  const joint = go.addBehavior(BallJoint, init);
  return { go, joint };
}

/** The angle (radians) of the turn between two rotations. */
const between = (a: Quaternion, b: Quaternion) => Quaternion.angle(a, b);

describe("ball joint drive (ADR 0375)", () => {
  it.each([
    ["y", Quaternion.axisAngle([0, 1, 0], 0.5)],
    ["z", Quaternion.axisAngle([0, 0, 1], -0.4)],
    ["x (the twist axis)", Quaternion.axisAngle([1, 0, 0], 0.6)],
  ])("turns the body to a target about %s", async (_name, target) => {
    const engine = await setup();
    const { go } = pinned({ useDrive: true, drive: { targetRotation: { x: target.x, y: target.y, z: target.z, w: target.w }, stiffness: 50, damping: 8, maxForce: 1000 } });
    steps(engine, 240);
    expect(between(go.transform!.worldRotation, target)).toBeLessThan(0.02);
  });

  it("reaches a combined target (small angles about every axis)", async () => {
    const engine = await setup();
    const target = Quaternion.euler(0.2, -0.3, 0.25, "XYZ");
    const { go } = pinned({ useDrive: true, drive: { targetRotation: { x: target.x, y: target.y, z: target.z, w: target.w }, stiffness: 50, damping: 8, maxForce: 1000 } });
    steps(engine, 300);
    expect(between(go.transform!.worldRotation, target)).toBeLessThan(0.03);
  });

  it("follows a target that changes while running", async () => {
    const engine = await setup();
    const { go, joint } = pinned({ useDrive: true, drive: { targetRotation: { x: 0, y: 0, z: 0, w: 1 }, stiffness: 50, damping: 8, maxForce: 1000 } });
    steps(engine, 30);
    const t = Quaternion.axisAngle([0, 1, 0], 0.7);
    joint.drive = { ...joint.drive, targetRotation: { x: t.x, y: t.y, z: t.z, w: t.w } };
    steps(engine, 240);
    expect(between(go.transform!.worldRotation, t)).toBeLessThan(0.02);
  });

  it("holds against gravity: a limp pendulum falls, a driven one stays near its target", async () => {
    const engine = await setup();
    const limp = pinned({}, true);
    limp.go.getBehavior(BallJoint)!.anchor.set(-1, 0, 0);
    const held = pinned({ useDrive: true, drive: { targetRotation: { x: 0, y: 0, z: 0, w: 1 }, stiffness: 500, damping: 30, maxForce: 1000 } }, true);
    held.go.transform!.position.set(0, 0, 5);
    held.joint.anchor.set(-1, 0, 0);
    steps(engine, 180);
    expect(limp.go.transform!.position.y).toBeLessThan(-0.7);
    expect(held.go.transform!.position.y).toBeGreaterThan(-0.2);
  });

  it("maxForce caps the torque: a weak drive can't hold what a strong one can", async () => {
    const engine = await setup();
    const make = (maxForce: number, z: number) => {
      const p = pinned({ useDrive: true, drive: { targetRotation: { x: 0, y: 0, z: 0, w: 1 }, stiffness: 500, damping: 30, maxForce } }, true);
      p.go.transform!.position.set(0, 0, z);
      p.joint.anchor.set(-1, 0, 0);
      return p;
    };
    const weak = make(0.5, 0), strong = make(1000, 5);
    steps(engine, 180);
    expect(weak.go.transform!.position.y).toBeLessThan(-0.7);
    expect(strong.go.transform!.position.y).toBeGreaterThan(-0.2);
  });

  it("turning the drive off frees the body again", async () => {
    const engine = await setup();
    const { go, joint } = pinned({ useDrive: true, drive: { targetRotation: { x: 0, y: 0, z: 0, w: 1 }, stiffness: 500, damping: 30, maxForce: 1000 } }, true);
    joint.anchor.set(-1, 0, 0);
    steps(engine, 60);
    expect(go.transform!.position.y).toBeGreaterThan(-0.2);
    joint.useDrive = false;
    steps(engine, 120);
    expect(go.transform!.position.y).toBeLessThan(-0.7);
  });
});

describe("ball joint swing (ADR 0375)", () => {
  /** The angle (degrees) a body spun about `axis` at 120 degrees a second for a second ends up turned, under the swing limits. */
  async function spunTo(axis: "y" | "z", swing: { y: number; z: number }) {
    const engine = await setup();
    const { go } = pinned({ useLimits: true, swing, twistLimits: { min: -5, max: 5 } });
    go.getBehavior(RigidBody)!.angularVelocity = axis === "y" ? { x: 0, y: 120, z: 0 } : { x: 0, y: 0, z: 120 };
    steps(engine, 60);
    return (between(go.transform!.worldRotation, Quaternion.identity) * 180) / Math.PI;
  }

  it("limits turns about the frame's y axis by swing.y, whatever swing.z is", async () => {
    expect(await spunTo("y", { y: 30, z: 80 })).toBeLessThan(36);
    expect(await spunTo("y", { y: 80, z: 30 })).toBeGreaterThan(60);
  });

  it("limits turns about the frame's z axis by swing.z, whatever swing.y is", async () => {
    expect(await spunTo("z", { y: 80, z: 30 })).toBeLessThan(36);
    expect(await spunTo("z", { y: 30, z: 80 })).toBeGreaterThan(60);
  });

  it("an unlimited ball joint swings freely", async () => {
    const engine = await setup();
    const { go } = pinned({ swing: { y: 10, z: 10 } });
    go.getBehavior(RigidBody)!.angularVelocity = { x: 0, y: 120, z: 0 };
    steps(engine, 60);
    expect((between(go.transform!.worldRotation, Quaternion.identity) * 180) / Math.PI).toBeGreaterThan(90);
  });
});
