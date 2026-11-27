// The shared physics sync core (ADR 0137) against a fake backend: no Rapier. Each test's World chooses
// the fake through `physics.backend2d`, beside the Rapier backend the test setup registers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, BoxCollider2D, CharacterController2D, Engine, GameBehavior, GameObject, HingeJoint2D, RigidBody2D, ShapeCollider2D, Tilemap, type Collision2D, type Joint2D } from "../../myco";
import { applyTestPlugins } from "../testPlugins";
import type { BackendBody, BackendCollider, BodySettings, ColliderDesc, Dim2, JointDesc, PhysicsBackend2D, PhysicsWorld2DBackend, Pose, ShapeDesc2D, VoxelChange2D, VoxelLink2D } from "./runtime";
import { registerPhysicsBackend } from "./runtime";
import { RAD2DEG } from "../../engine/core/math";
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
  applyImpulse(j: { x: number; y: number }): void {
    this.velocity = { x: this.velocity.x + j.x / this.settings!.mass, y: this.velocity.y + j.y / this.settings!.mass };
  }
  applyTorqueImpulse(j: number): void {
    if (!this.settings!.lockRotation[0]) this.spin += j / this.settings!.inertia;
  }
  setStepForce(): void {}
}

/** A world that moves dynamic bodies by their velocity (no gravity, no contacts) and reports the events a test queues. */
class FakeWorld implements PhysicsWorld2DBackend {
  gravity = { x: 0, y: 0 };
  readonly bodies: FakeBody[] = [];
  readonly colliders = new Map<number, ColliderDesc<Dim2>>();
  readonly joints: JointDesc<Dim2>[] = [];
  removedJoints = 0;
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
  removeJoint(): void {
    this.removedJoints++;
  }
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
  readonly drops: BackendBody<Dim2>[] = [];
  dropThrough(body: BackendBody<Dim2>): void {
    this.drops.push(body);
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

/** The fake body the core made for the test's one RigidBody2D of a body type (what the backend was handed). */
const fakeOf = (bodyType: RigidBody2D["bodyType"] = "dynamic") => {
  const found = fake!.bodies.filter((b) => b.type === bodyType && !b.removed);
  expect(found).toHaveLength(1);
  return found[0];
};

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
    fakeOf("dynamic").log.length = 0;
    fakeOf("kinematic").log.length = 0;
    step(engine);
    expect(fakeOf("dynamic").log).toEqual([]); // untouched: no sync
    dyn.node.transform!.position.x = 3;
    kin.node.transform!.position.x = 4;
    step(engine);
    expect(fakeOf("dynamic").log).toEqual(["teleport"]);
    expect(fakeOf("dynamic").position.x).toBe(3);
    expect(fakeOf("kinematic").log).toEqual(["kinematic"]);
    expect(fakeOf("kinematic").position.x).toBe(4); // reached its target in the step
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
    // The two colliders' backend ids, as the core created them: a contact pair reaches both nodes, whichever comes first.
    expect(fake!.colliders.size).toBe(2);
    const [ia, ib] = [...fake!.colliders.keys()];
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
    const { node } = await body(engine, "spinner");
    step(engine);
    fakeOf().rotation = 3.1;
    step(engine);
    fakeOf().rotation = -3.1; // 0.083 rad further on, wrapped
    step(engine);
    physics2DOf(engine.world)!.interpolate(0.5);
    const angle = node.transform!.worldRotation2D; // radians (ADR 0164)
    expect(Math.abs(Math.abs(angle) - Math.PI)).toBeLessThan(0.01); // halfway is ±π, not 0
    physics2DOf(engine.world)!.restoreInterpolated();
    expect(node.transform!.worldRotation2D).toBeCloseTo(-3.1, 3);
    engine.dispose();
  });

  it("breaks a joint whose estimated force passes its breakForce, once, calling onJointBreak", async () => {
    const engine = await setup();
    const broken: number[] = [];
    class Listener extends GameBehavior {
      onJointBreak(_j: Joint2D, force: number) { broken.push(force); }
    }
    const { node } = await body(engine, "door");
    node.addBehavior(HingeJoint2D, { breakForce: 50 });
    node.addBehavior(Listener);
    step(engine);
    expect(fake!.joints).toHaveLength(1);
    expect(fake!.joints[0].kind).toBe("revolute");
    // A gentle tug: 1 unit/s in a step is 60 N for a 1 kg body.
    fake!.onStep = () => (fakeOf().velocity = { x: 0.5, y: 0 });
    step(engine);
    expect(broken).toEqual([]);
    fake!.onStep = () => (fakeOf().velocity = { x: 10, y: 0 });
    step(engine);
    expect(broken).toHaveLength(1);
    expect(broken[0]).toBeGreaterThan(50);
    expect(fake!.removedJoints).toBe(1); // broken: taken out of the backend world
    step(engine, 3);
    expect(broken).toHaveLength(1);
    expect(fake!.joints).toHaveLength(1); // and never rebuilt
    expect(node.getBehavior(HingeJoint2D)).toBeNull(); // destroyed
    engine.dispose();
  });
});

describe("a RigidBody2D's commands before its body exists (ADR 0283)", () => {
  it("applies linear and angular impulses given before the body exists as the body itself would", async () => {
    const engine = await setup();
    const early = await body(engine, "early"); // no step yet: no backend body
    early.rb.addForce({ x: 2, y: 0 }, "impulse");
    early.rb.addTorque(0.5, "impulse");
    early.rb.addTorque(0.5, "impulse");
    const frozen = await body(engine, "frozen");
    frozen.rb.constraints = { freezePosition: { x: false, y: false }, freezeRotation: true };
    frozen.rb.addTorque(1, "impulse");
    expect(frozen.rb.angularVelocity).toBe(0); // no spin around a frozen axis
    step(engine);
    const late = await body(engine, "late");
    step(engine); // its body exists now
    late.rb.addForce({ x: 2, y: 0 }, "impulse");
    late.rb.addTorque(1, "impulse");
    expect(late.rb.angularVelocity).toBeCloseTo(6 * RAD2DEG); // 1 / (mass 1 / 6)
    expect(early.rb.angularVelocity).toBeCloseTo(late.rb.angularVelocity, 6); // not a one-step torque
    expect(early.rb.velocity.x).toBeCloseTo(late.rb.velocity.x, 6);
    expect(frozen.rb.angularVelocity).toBe(0);
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
      expect(rb.velocity.x).toBe(2); // no backend body: kept for when physics runs
      expect(node.transform!.position.x).toBe(0); // nothing moves it
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("No 2D physics backend"))).toHaveLength(1);
      engine.dispose();
    } finally {
      warn.mockRestore();
      applyTestPlugins();
    }
  });
});

describe("one-way colliders and drop-through in the core (ADR 0437)", () => {
  /** A World on a fake backend with or without one-way platforms. */
  async function oneWaySetup(oneWayPlatforms: boolean) {
    const id = oneWayPlatforms ? "fake-oneway" : "fake";
    const backend: PhysicsBackend2D = { capabilities: { ...fakeBackend.capabilities, oneWayPlatforms }, createWorld: () => (fake = new FakeWorld()) };
    unregister.push(registerPhysicsBackend({ id, dimension: "2d", load: async () => backend }));
    Assets.clearSources();
    return Engine.create({ headless: true, project: { physics: { gravity: [0, 0], layers: ["Default"], backend2d: id } } });
  }
  const descs = () => [...fake!.colliders.values()];

  it("describes a one-way collider by its node's +Y, its top and its base, turned and mirrored with the node", async () => {
    const engine = await oneWaySetup(true);
    const plank = GameObject.create("plank");
    plank.transform!.position = [1, 2, 0];
    plank.addBehavior(BoxCollider2D, { size: { x: 4, y: 1 } as never, oneWay: true });
    const turned = GameObject.create("turned");
    turned.transform!.position = [0, 10, 0];
    turned.transform!.eulerAngles = [0, 0, Math.PI / 2]; // +Y points along -x
    turned.addBehavior(BoxCollider2D, { size: { x: 4, y: 1 } as never, oneWay: true });
    const mirrored = GameObject.create("mirrored");
    mirrored.transform!.position = [0, -5, 0];
    mirrored.transform!.scale = [1, -1, 1]; // +Y points down
    mirrored.addBehavior(BoxCollider2D, { size: { x: 4, y: 1 } as never, center: { x: 0, y: 1 } as never, oneWay: true });
    GameObject.create("solid").addBehavior(BoxCollider2D);
    await vi.waitFor(() => expect(physics2DOf(engine.world)).not.toBeNull());
    step(engine);
    const [a, b, c, d] = descs();
    expect(a.oneWay!.up.x).toBeCloseTo(0);
    expect(a.oneWay!.up.y).toBeCloseTo(1);
    expect(a.oneWay!.top).toBeCloseTo(2.5);
    expect(a.oneWay!.base).toBeCloseTo(2);
    expect(b.oneWay!.up.x).toBeCloseTo(-1);
    expect(b.oneWay!.up.y).toBeCloseTo(0);
    expect(b.oneWay!.top).toBeCloseTo(0.5); // its half height along -x, from x = 0
    expect(b.oneWay!.base).toBeCloseTo(0);
    expect(c.oneWay!.up.y).toBeCloseTo(-1);
    expect(c.oneWay!.base).toBeCloseTo(6); // its centre, mirrored to y = -6, measured along -y
    expect(c.oneWay!.top).toBeCloseTo(6.5);
    expect(d.oneWay ?? null).toBeNull();
    engine.dispose();
  });

  it("never makes triggers or character controllers one-way, and rebuilds a body-less one-way collider when its node moves", async () => {
    const engine = await oneWaySetup(true);
    GameObject.create("trigger").addBehavior(BoxCollider2D, { isTrigger: true, oneWay: true });
    const cc = GameObject.create("player").addBehavior(CharacterController2D);
    cc.oneWay = true;
    const plank = GameObject.create("plank");
    plank.addBehavior(BoxCollider2D, { oneWay: true });
    await vi.waitFor(() => expect(physics2DOf(engine.world)).not.toBeNull());
    step(engine);
    expect(descs().filter((d) => d.oneWay)).toHaveLength(1);
    plank.transform!.position = [0, 3, 0];
    step(engine);
    const tops = descs().filter((d) => d.oneWay).map((d) => d.oneWay!.top);
    expect(tops).toHaveLength(1);
    expect(tops[0]).toBeCloseTo(3.5);
    engine.dispose();
  });

  it("forwards dropThrough with the body: a rigid body's, a character controller's own", async () => {
    const engine = await oneWaySetup(true);
    const { rb } = await body(engine, "crate");
    const cc = GameObject.create("player").addBehavior(CharacterController2D);
    step(engine);
    rb.dropThrough();
    cc.dropThrough();
    expect(fake!.drops).toEqual([fakeOf("dynamic"), fakeOf("kinematic")]);
    engine.dispose();
  });

  it("without one-way platforms: solid, a warning once, and dropThrough does nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const engine = await oneWaySetup(false);
      const { rb } = await body(engine, "crate");
      GameObject.create("a").addBehavior(BoxCollider2D, { oneWay: true });
      GameObject.create("b").addBehavior(BoxCollider2D, { oneWay: true });
      step(engine);
      expect(descs().every((d) => !d.oneWay)).toBe(true);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("no one-way platforms"))).toHaveLength(1);
      rb.dropThrough();
      expect(fake!.drops).toHaveLength(0);
      engine.dispose();
    } finally {
      warn.mockRestore();
    }
  });
});

/** A fake world with voxel colliders (ADR 0442): records what the core asks of them. */
class FakeVoxelWorld extends FakeWorld {
  readonly log: string[] = [];
  /** Live voxel colliders by id: their filled cells as "x,y". */
  readonly voxels = new Map<number, Set<string>>();
  override createCollider(desc: ColliderDesc<Dim2>): BackendCollider<Dim2> {
    const c = super.createCollider(desc);
    if (desc.shape.kind === "voxels") {
      const cells = new Set<string>();
      for (let i = 0; i < desc.shape.cells.length; i += 2) cells.add(`${desc.shape.cells[i]},${desc.shape.cells[i + 1]}`);
      this.voxels.set(c.id, cells);
    }
    this.log.push(`create ${c.id} ${desc.shape.kind}`);
    return c;
  }
  override removeCollider(c: BackendCollider<Dim2>): void {
    super.removeCollider(c);
    this.voxels.delete(c.id);
    this.log.push(`remove ${c.id}`);
  }
  setVoxels(c: BackendCollider<Dim2>, changes: readonly VoxelChange2D[], neighbours: readonly VoxelLink2D[]): void {
    const cells = this.voxels.get(c.id)!;
    for (const ch of changes) {
      if (ch.filled) cells.add(`${ch.x},${ch.y}`);
      else cells.delete(`${ch.x},${ch.y}`);
    }
    this.log.push(`set ${c.id} ${changes.map((ch) => `${ch.x},${ch.y}${ch.filled ? "+" : "-"}`).join(" ")} → ${neighbours.map((n) => n.collider.id).sort((a, b) => a - b).join(",")}`);
  }
  linkVoxels(a: BackendCollider<Dim2>, b: BackendCollider<Dim2>, shift: { x: number; y: number }): void {
    this.log.push(`link ${a.id} ${b.id} ${shift.x},${shift.y}`);
  }
  /** Every filled cell of every voxel collider, in the colliders' frames. */
  cells(): string[] {
    return [...this.voxels.values()].flatMap((s) => [...s]).sort();
  }
}

describe("ShapeCollider2D as voxel colliders in the core (ADR 0442)", () => {
  const TILES = { format: "myco.tileset@1", tileSize: [16, 16], tiles: [{ id: 1, sprite: "", collision: "full" }, { id: 2, sprite: "", collision: "oneWay" }, { id: 3, sprite: "", collision: { polygon: [[0, 0], [1, 0], [1, 1]] } }] };
  let voxelWorld: FakeVoxelWorld | null = null;
  /** A World on a fake backend with or without voxel colliders, and a tile map with a ShapeCollider2D. */
  async function voxelSetup(voxelColliders: boolean, mode: "rectangles" | "outline" = "rectangles") {
    const id = voxelColliders ? "fake-voxels" : "fake-plain";
    const createWorld = () => (fake = voxelColliders ? (voxelWorld = new FakeVoxelWorld()) : new FakeWorld());
    const backend: PhysicsBackend2D = { capabilities: { ...fakeBackend.capabilities, voxelColliders }, createWorld };
    unregister.push(registerPhysicsBackend({ id, dimension: "2d", load: async () => backend }));
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "tiles.tileset.json": TILES }));
    const engine = await Engine.create({ headless: true, project: { physics: { gravity: [0, 0], layers: ["Default"], backend2d: id } } });
    const node = GameObject.create("map");
    const tiles = node.addBehavior(Tilemap, { tileset: "tiles.tileset.json" });
    tiles.fillRect(-20, -8, 40, 1, 1); // cells x −20..19 on row −8, away from the chunks' top and bottom edges: chunks (−2, −1) to (1, −1)
    tiles.setTile(30, 5, 3); // a polygon tile
    node.addBehavior(ShapeCollider2D, { mode });
    await vi.waitFor(() => expect(physics2DOf(engine.world)).not.toBeNull());
    step(engine);
    return { engine, node, tiles };
  }
  const kinds = () => [...fake!.colliders.values()].map((d) => d.shape.kind).sort();

  it("without the capability, the map stays one compound of boxes and polygon parts", async () => {
    const { engine, tiles } = await voxelSetup(false);
    expect(kinds()).toEqual(["compound"]);
    const compound = [...fake!.colliders.values()][0].shape as Extract<ShapeDesc2D, { kind: "compound" }>;
    expect(compound.parts.map((p) => p.shape.kind).sort()).toEqual(["box", "box", "box", "box", "convexHull"]); // a box per chunk's run
    tiles.clearTile(5, -8);
    step(engine);
    expect(kinds()).toEqual(["compound"]);
    engine.dispose();
  });

  it("in outline mode, even with the capability, the map is built from its shapes", async () => {
    const { engine } = await voxelSetup(true, "outline");
    expect(kinds()).toEqual(["compound", "polyline"]);
    engine.dispose();
  });

  it("builds a voxel collider per chunk, linked with its neighbours, beside one compound for the polygon tiles", async () => {
    const { engine } = await voxelSetup(true);
    const w = voxelWorld as FakeVoxelWorld;
    expect(kinds()).toEqual(["compound", "voxels", "voxels", "voxels", "voxels"]);
    const compound = [...w.colliders.values()].find((d) => d.shape.kind === "compound")!.shape as Extract<ShapeDesc2D, { kind: "compound" }>;
    expect(compound.parts.map((p) => p.shape.kind)).toEqual(["convexHull"]); // the whole cells aren't in it
    expect(w.log.filter((l) => l.startsWith("link"))).toHaveLength(3); // each chunk with the one before it
    expect(w.log.filter((l) => l.startsWith("link")).every((l) => l.endsWith(" 0,0"))).toBe(true); // one origin per group
    const expected: string[] = [];
    for (let x = -20; x < 20; x++) expected.push(`${x},-8`);
    expect(w.cells()).toEqual(expected.sort());
    for (const d of w.colliders.values()) if (d.shape.kind === "voxels") expect(d.shape.size).toEqual({ x: 1, y: 1 });
    engine.dispose();
  });

  it("edits cells in place, passes border edits to the neighbours, removes emptied chunks, adds new ones, and rebuilds the compound only for polygon edits", async () => {
    const { engine, tiles } = await voxelSetup(true);
    const w = voxelWorld as FakeVoxelWorld;
    const idOf = (x: number) => [...w.voxels].find(([, cells]) => cells.has(`${x},-8`))![0];
    const [a, b, c, d] = [-20, -10, 5, 18].map(idOf); // chunks −2, −1, 0, 1
    w.log.length = 0;
    tiles.clearTile(5, -8); // inside chunk 0
    step(engine);
    expect(w.log).toEqual([`set ${c} 5,-8- → `]);
    w.log.length = 0;
    tiles.clearTile(-1, -8); // chunk −1's last column, beside chunk 0
    tiles.setTile(-10, 0, 1); // and a new cell inside chunk (−1, 0)
    step(engine);
    expect(w.log).toEqual([`set ${b} -1,-8- → ${[a, c].sort((p, q) => p - q).join(",")}`, expect.stringMatching(/^create \d+ voxels$/), ...[a, b, c].map((n) => expect.stringMatching(new RegExp(`^link \\d+ ${n} 0,0$`)))]);
    w.log.length = 0;
    tiles.fillRect(16, -8, 4, 1, 0); // all of chunk 1
    step(engine);
    expect(w.log).toEqual([`set ${d} 16,-8- 17,-8- 18,-8- 19,-8- → ${c}`, `remove ${d}`]);
    w.log.length = 0;
    tiles.setTile(30, 6, 3); // a polygon tile: the compound is rebuilt, the voxels left alone
    step(engine);
    expect(w.log).toEqual([expect.stringMatching(/^remove \d+$/), expect.stringMatching(/^create \d+ compound$/)]);
    w.log.length = 0;
    tiles.setTile(31, 6, 2); // a one-way tile: built beside the polygons
    step(engine);
    expect(w.log).toEqual([expect.stringMatching(/^remove \d+$/), expect.stringMatching(/^create \d+ compound$/), expect.stringMatching(/^create \d+ compound$/)]);
    engine.dispose();
  });

  it("maps a mirrored map's cells instead of scaling the voxels, and rebuilds when the collider's settings change", async () => {
    const { engine, node } = await voxelSetup(true);
    const w = voxelWorld as FakeVoxelWorld;
    node.transform!.scale = [-2, 1, 1];
    step(engine);
    const expected: string[] = [];
    for (let x = -20; x < 20; x++) expected.push(`${-x - 1},-8`);
    expect(w.cells()).toEqual(expected.sort());
    for (const d of w.colliders.values()) if (d.shape.kind === "voxels") expect(d.shape.size).toEqual({ x: 2, y: 1 });
    w.log.length = 0;
    node.getComponent(ShapeCollider2D)!.isTrigger = true;
    step(engine);
    expect(w.log.filter((l) => l.startsWith("remove"))).toHaveLength(5);
    expect([...w.colliders.values()].every((d) => d.sensor)).toBe(true);
    engine.dispose();
  });
});
