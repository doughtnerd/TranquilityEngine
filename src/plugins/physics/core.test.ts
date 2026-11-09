// The shared physics sync core (ADR 0137) against a fake backend: no Rapier. Each test's World chooses
// the fake through `physics.backend2d`, beside the Rapier backend the test setup registers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, BoxCollider2D, Engine, GameBehavior, GameObject, HingeJoint2D, RigidBody2D, type Collision2D, type Joint2D } from "../../myco";
import { applyTestPlugins } from "../testPlugins";
import type { BackendBody, BackendCollider, BodySettings, ColliderDesc, Dim2, JointDesc, PhysicsBackend2D, PhysicsWorld2DBackend, Pose } from "./runtime";
import { registerPhysicsBackend } from "./runtime";
import { wrapAngle } from "./runtime/core";
import { physics2DOf } from "./runtime/systems2d";

type P2 = Pose<Dim2>;

class FakeBody implements BackendBody<Dim2> {
  removed = false;
  position = { x: 0, y: 0 };
  rotation = 0;
  velocity = { x: 0, y: 0 };
  spin = 0;
  target: P2 | null = null;
  settings: BodySettings | null = null;
  readonly log: string[] = [];
  constructor(readonly type: string, pose: P2) {
    this.position = { ...pose.position };
    this.rotation = pose.rotation;
  }
  pose(): P2 {
    return { position: { ...this.position }, rotation: this.rotation };
  }
  teleport(p: P2): void {
    this.log.push("teleport");
    this.position = { ...p.position };
    this.rotation = p.rotation;
  }
  moveKinematic(p: P2): void {
    this.log.push("kinematic");
    this.target = p;
  }
  place(position: { x: number; y: number }): void {
    this.position = { ...position };
  }
  configure(s: BodySettings): void {
    this.settings = s;
  }
  setEnabled(): void {}
  isSleeping(): boolean {
    return false;
  }
  isFixed(): boolean {
    return this.type === "static";
  }
  wakeUp(): void {}
  linearVelocity() {
    return { ...this.velocity };
  }
  setLinearVelocity(v: { x: number; y: number }): void {
    this.velocity = { ...v };
  }
  angularVelocity(): number {
    return this.spin;
  }
  setAngularVelocity(w: number): void {
    this.spin = w;
  }
  applyImpulse(): void {}
  applyTorqueImpulse(): void {}
  setStepForce(): void {}
}

/** A world that moves dynamic bodies by their velocity (no gravity, no contacts) and reports the events a test queues. */
class FakeWorld implements PhysicsWorld2DBackend {
  gravity = { x: 0, y: 0 };
  readonly bodies: FakeBody[] = [];
  readonly colliders = new Map<number, ColliderDesc<Dim2>>();
  readonly joints: JointDesc<Dim2>[] = [];
  readonly events: [number, number, boolean][] = [];
  onStep: (() => void) | null = null;
  private nextId = 1;
  step(dt: number): void {
    this.onStep?.();
    for (const b of this.bodies) {
      if (b.removed) continue;
      if (b.type === "dynamic") {
        b.position = { x: b.position.x + b.velocity.x * dt, y: b.position.y + b.velocity.y * dt };
        b.rotation += b.spin * dt;
      } else if (b.type === "kinematic" && b.target) {
        b.position = { ...b.target.position };
        b.rotation = b.target.rotation;
      }
    }
  }
  free(): void {}
  createBody(type: string, pose: P2, settings: BodySettings | null): FakeBody {
    const b = new FakeBody(type, pose);
    if (settings) b.configure(settings);
    this.bodies.push(b);
    return b;
  }
  removeBody(b: BackendBody<Dim2>): void {
    (b as FakeBody).removed = true;
  }
  createCollider(desc: ColliderDesc<Dim2>): BackendCollider<Dim2> {
    const id = this.nextId++;
    this.colliders.set(id, desc);
    return { id, setEnabled() {}, setLocalPose() {}, setPose() {} };
  }
  removeCollider(c: BackendCollider<Dim2>): void {
    this.colliders.delete(c.id);
  }
  createJoint(desc: JointDesc<Dim2>) {
    this.joints.push(desc);
    return { configure() {} };
  }
  removeJoint(): void {}
  createCharacter() {
    return { configure() {}, move: (_c: unknown, motion: { x: number; y: number }) => ({ movement: motion, grounded: false, hits: [] }) };
  }
  removeCharacter(): void {}
  drainCollisionEvents(fn: (a: number, b: number, started: boolean) => void): void {
    for (const [a, b, s] of this.events.splice(0)) fn(a, b, s);
  }
  contactImpulses() {
    return [];
  }
  raycast() {
    return null;
  }
  castShape() {
    return null;
  }
  castCollider() {
    return null;
  }
  overlap() {
    return [];
  }
  overlapPoint() {
    return [];
  }
}

let fake: FakeWorld | null = null;
const fakeBackend: PhysicsBackend2D = {
  capabilities: { characterController: true, jointMotors: true, continuousCollision: false, oneWayPlatforms: false, meshColliders: false },
  createWorld: () => (fake = new FakeWorld()),
};

const unregister: (() => void)[] = [];
afterEach(() => {
  for (const u of unregister.splice(0)) u();
  fake = null;
});

async function setup() {
  unregister.push(registerPhysicsBackend({ id: "fake", dimension: "2d", load: async () => fakeBackend }));
  Assets.clearSources();
  const engine = await Engine.create({ headless: true, project: { physics: { gravity: [0, 0], layers: ["Default"], backend2d: "fake" } } });
  return engine;
}

const step = (engine: Engine, n = 1) => {
  for (let i = 0; i < n; i++) engine.step(1 / 60);
};

/** The fake body behind a RigidBody2D. */
const fakeOf = (rb: RigidBody2D) => rb._state!.body as FakeBody;

async function body(engine: Engine, name: string, data: { bodyType?: RigidBody2D["bodyType"] } = {}) {
  const node = GameObject.create(name);
  const rb = node.addBehavior(RigidBody2D, { useGravity: false, ...data });
  const col = node.addBehavior(BoxCollider2D);
  await vi.waitFor(() => expect(physics2DOf(engine.world)).not.toBeNull());
  return { node, rb, col };
}

describe("the shared physics core over a fake backend (ADR 0137)", () => {
  it("runs the backend the project names", async () => {
    const engine = await setup();
    await body(engine, "a");
    step(engine);
    expect(fake).not.toBeNull();
    expect(fake!.bodies).toHaveLength(1);
    engine.dispose();
  });

  it("teleports a dynamic body a script moved, and moves a kinematic one kinematically", async () => {
    const engine = await setup();
    const dyn = await body(engine, "dynamic");
    const kin = await body(engine, "kinematic", { bodyType: "kinematic" });
    step(engine);
    fakeOf(dyn.rb).log.length = 0;
    fakeOf(kin.rb).log.length = 0;
    step(engine);
    expect(fakeOf(dyn.rb).log).toEqual([]); // untouched: no sync
    dyn.node.transform!.position.x = 3;
    kin.node.transform!.position.x = 4;
    step(engine);
    expect(fakeOf(dyn.rb).log).toEqual(["teleport"]);
    expect(fakeOf(dyn.rb).position.x).toBe(3);
    expect(fakeOf(kin.rb).log).toEqual(["kinematic"]);
    expect(fakeOf(kin.rb).position.x).toBe(4); // reached its target in the step
    engine.dispose();
  });

  it("calls Enter once, Stay on each later step while touching, then Exit", async () => {
    const engine = await setup();
    const calls: string[] = [];
    class Probe extends GameBehavior {
      onCollisionEnter(c: Collision2D) { calls.push(`enter:${c.collider.node.name}`); }
      onCollisionStay(c: Collision2D) { calls.push(`stay:${c.collider.node.name}`); }
      onCollisionExit(c: Collision2D) { calls.push(`exit:${c.collider.node.name}`); }
    }
    const a = await body(engine, "a");
    a.node.addBehavior(Probe);
    const b = await body(engine, "b");
    step(engine);
    const ia = a.col._state!.collider.id, ib = b.col._state!.collider.id;
    fake!.events.push([ia, ib, true]);
    step(engine);
    expect(calls).toEqual(["enter:b"]);
    step(engine, 2);
    expect(calls).toEqual(["enter:b", "stay:b", "stay:b"]);
    fake!.events.push([ib, ia, false]);
    step(engine);
    step(engine);
    expect(calls).toEqual(["enter:b", "stay:b", "stay:b", "exit:b"]);
    engine.dispose();
  });

  it("interpolates a 2D body turning past ±π the short way", async () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-3.2)).toBeCloseTo(-3.2 + 2 * Math.PI);
    const engine = await setup();
    const { node, rb } = await body(engine, "spinner");
    step(engine);
    fakeOf(rb).rotation = 3.1;
    step(engine);
    fakeOf(rb).rotation = -3.1; // 0.083 rad further on, wrapped
    step(engine);
    physics2DOf(engine.world)!.interpolate(0.5);
    const deg = node.transform!.worldRotation2D;
    expect(Math.abs(Math.abs(deg) - 180)).toBeLessThan(0.5); // halfway is ±180°, not 0°
    physics2DOf(engine.world)!.restoreInterpolated();
    expect(node.transform!.worldRotation2D).toBeCloseTo((-3.1 * 180) / Math.PI, 3);
    engine.dispose();
  });

  it("breaks a joint whose estimated force passes its breakForce, once, calling onJointBreak", async () => {
    const engine = await setup();
    const broken: number[] = [];
    class Listener extends GameBehavior {
      onJointBreak(_j: Joint2D, force: number) { broken.push(force); }
    }
    const { node, rb } = await body(engine, "door");
    const joint = node.addBehavior(HingeJoint2D, { breakForce: 50 });
    node.addBehavior(Listener);
    step(engine);
    expect(fake!.joints).toHaveLength(1);
    expect(fake!.joints[0].kind).toBe("revolute");
    // A gentle tug: 1 unit/s in a step is 60 N for a 1 kg body.
    fake!.onStep = () => (fakeOf(rb).velocity = { x: 0.5, y: 0 });
    step(engine);
    expect(broken).toEqual([]);
    fake!.onStep = () => (fakeOf(rb).velocity = { x: 10, y: 0 });
    step(engine);
    expect(broken).toHaveLength(1);
    expect(broken[0]).toBeGreaterThan(50);
    expect(joint._broken).toBe(true);
    step(engine, 3);
    expect(broken).toHaveLength(1);
    expect(node.getBehavior(HingeJoint2D)).toBeNull(); // destroyed
    engine.dispose();
  });
});

describe("with no physics backend enabled (ADR 0137)", () => {
  it("leaves physics Components inert and warns once per World", async () => {
    applyTestPlugins(["myco.physics-rapier"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      Assets.clearSources();
      const engine = await Engine.create({ headless: true });
      const node = GameObject.create("crate");
      const rb = node.addBehavior(RigidBody2D);
      node.addBehavior(BoxCollider2D);
      await vi.waitFor(() => expect(warn.mock.calls.filter((c) => String(c[0]).includes("No 2D physics backend"))).toHaveLength(1));
      GameObject.create("another").addBehavior(RigidBody2D);
      rb.velocity = { x: 2, y: 0 };
      step(engine, 10);
      await new Promise((r) => setTimeout(r, 10));
      expect(physics2DOf(engine.world)).toBeNull();
      expect(rb._state).toBeNull();
      expect(rb.velocity.x).toBe(2); // kept for when physics runs
      expect(node.transform!.position.x).toBe(0); // nothing moves it
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("No 2D physics backend"))).toHaveLength(1);
      engine.dispose();
    } finally {
      warn.mockRestore();
      applyTestPlugins();
    }
  });
});
