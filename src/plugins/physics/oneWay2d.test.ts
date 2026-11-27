// One-way 2D colliders, character controllers honouring them, and drop-through (ADR 0437), on Rapier.
import { afterEach, describe, expect, it } from "vitest";
import { Assets, BoxCollider2D, CharacterController2D, Engine, GameObject, RigidBody2D, SceneManager } from "../../myco";

const project = { physics: { gravity: [0, -10] as [number, number], layers: ["Default"] } };
const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});

async function setup() {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics: "2d" }, nodes: [] } }));
  const engine = await Engine.create({ headless: true, project });
  engines.push(engine);
  await SceneManager.load("s.json");
  return engine;
}

const steps = (engine: Engine, n: number) => {
  for (let i = 0; i < n; i++) engine.step(1 / 60);
};

/** A static box collider: `size` wide and high, centred at `(x, y)`, turned `degrees`. */
function slab(name: string, x: number, y: number, size: [number, number], oneWay: boolean, degrees = 0) {
  const go = GameObject.create(name);
  go.transform!.position = [x, y, 0];
  if (degrees) go.transform!.eulerAngles = [0, 0, (degrees * Math.PI) / 180];
  go.addBehavior(BoxCollider2D, { size: { x: size[0], y: size[1] } as never, oneWay });
  return go;
}

/** A dynamic 0.8 × 0.8 box at `(x, y)` that doesn't turn. */
function crate(x: number, y: number) {
  const b = GameObject.create("crate");
  b.transform!.position = [x, y, 0];
  const rb = b.addBehavior(RigidBody2D, { constraints: { freezePosition: { x: false, y: false }, freezeRotation: true } });
  b.addBehavior(BoxCollider2D, { size: { x: 0.8, y: 0.8 } as never });
  return { b, rb };
}

/** Run `n` steps, returning the highest y the node reached. */
function track(engine: Engine, node: GameObject, n: number): number {
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    engine.step(1 / 60);
    maxY = Math.max(maxY, node.transform!.worldPosition.y);
  }
  return maxY;
}

/** A controller (capsule 2 tall: feet at y − 1) at `(x, y)`, and a frame of its own gravity and jumping. */
function controller(x: number, y: number) {
  const player = GameObject.create("player");
  player.transform!.position = [x, y, 0];
  const cc = player.addBehavior(CharacterController2D);
  let vy = 0;
  const frame = (engine: Engine, jump = 0) => {
    if (jump) vy = jump;
    vy -= 10 / 60;
    cc.move({ x: 0, y: vy / 60 });
    if (cc.isGrounded && vy < 0) vy = 0;
    engine.step(1 / 60);
  };
  return { player, cc, frame };
}

describe("one-way 2D colliders (ADR 0437)", () => {
  it("a one-way BoxCollider2D lets a body up through and holds it on top", async () => {
    const engine = await setup();
    slab("plank", 0, 2, [6, 0.5], true); // top at 2.25
    const { b, rb } = crate(0, 0);
    steps(engine, 2);
    rb.velocity = { x: 0, y: 12 };
    const maxY = track(engine, b, 180);
    expect(maxY).toBeGreaterThan(3);
    expect(b.transform!.worldPosition.y).toBeCloseTo(2.65, 1); // landed on top
  });

  it("the same box without oneWay is solid from below", async () => {
    const engine = await setup();
    slab("plank", 0, 2, [6, 0.5], false);
    const { b, rb } = crate(0, 0);
    steps(engine, 2);
    rb.velocity = { x: 0, y: 12 };
    expect(track(engine, b, 120)).toBeLessThan(2); // bumped its head on the underside (bottom at 1.75)
  });

  it("turns with the node: upside down it lets bodies fall through and stops them from below", async () => {
    const engine = await setup();
    slab("flipped", 0, 2, [6, 0.5], true, 180); // lets bodies through along -y
    slab("floor", 0, -3, [20, 1], false);
    const falling = crate(-1, 5);
    const rising = crate(1, 0);
    steps(engine, 2);
    rising.rb.velocity = { x: 0, y: 12 };
    const maxRise = track(engine, rising.b, 180);
    expect(falling.b.transform!.worldPosition.y).toBeCloseTo(-2.1, 1); // fell through onto the floor
    expect(maxRise).toBeLessThan(2); // held below it
  });

  it("triggers ignore oneWay", async () => {
    const engine = await setup();
    const sensor = slab("sensor", 0, 0, [6, 0.5], true);
    sensor.getBehavior(BoxCollider2D)!.isTrigger = true;
    const { b } = crate(0, 2);
    steps(engine, 120);
    expect(b.transform!.worldPosition.y).toBeLessThan(-3); // fell through, as through any trigger
  });
});

describe("character controllers and one-way colliders (ADR 0437)", () => {
  it("a CharacterController2D jumps up through a one-way box and lands on it", async () => {
    const engine = await setup();
    slab("floor", 0, -0.5, [20, 1], false);
    slab("plank", 0, 3, [6, 0.5], true); // top at 3.25
    const { player, cc, frame } = controller(0, 1.05);
    for (let i = 0; i < 30; i++) frame(engine);
    expect(cc.isGrounded).toBe(true);
    let maxY = -Infinity;
    frame(engine, 12);
    for (let i = 0; i < 240; i++) {
      frame(engine);
      maxY = Math.max(maxY, player.transform!.worldPosition.y);
    }
    expect(maxY).toBeGreaterThan(5); // its head went up through the plank
    expect(cc.isGrounded).toBe(true);
    expect(player.transform!.worldPosition.y).toBeCloseTo(4.25, 1); // standing on it
  });

  it("is still stopped from below by a solid box", async () => {
    const engine = await setup();
    slab("floor", 0, -0.5, [20, 1], false);
    slab("ceiling", 0, 3, [6, 0.5], false);
    const { player, frame } = controller(0, 1.05);
    for (let i = 0; i < 30; i++) frame(engine);
    let maxY = -Infinity;
    frame(engine, 12);
    for (let i = 0; i < 120; i++) {
      frame(engine);
      maxY = Math.max(maxY, player.transform!.worldPosition.y);
    }
    expect(maxY).toBeLessThan(1.8); // head against the underside at 2.75
  });
});

describe("drop-through (ADR 0437)", () => {
  it("RigidBody2D.dropThrough falls through the plank it stands on and is caught by the next one-way plank", async () => {
    const engine = await setup();
    slab("upper", 0, 2, [6, 0.5], true); // top at 2.25
    slab("lower", 0, -1, [6, 0.5], true); // top at -0.75
    slab("floor", 0, -4, [20, 1], false);
    const { b, rb } = crate(0, 3);
    steps(engine, 90);
    expect(b.transform!.worldPosition.y).toBeCloseTo(2.65, 1);
    steps(engine, 30);
    expect(b.transform!.worldPosition.y).toBeCloseTo(2.65, 1); // stays put until asked
    rb.dropThrough();
    steps(engine, 120);
    expect(b.transform!.worldPosition.y).toBeCloseTo(-0.35, 1); // on the lower plank, not the floor
    rb.velocity = { x: 0, y: 9 };
    expect(track(engine, b, 120)).toBeGreaterThan(2.7); // the upper plank lets it up again...
    expect(b.transform!.worldPosition.y).toBeCloseTo(2.65, 1); // ...and holds it once more: the mark has cleared
  });

  it("CharacterController2D.dropThrough falls through the plank it stands on and lands on the one below", async () => {
    const engine = await setup();
    slab("upper", 0, 2, [6, 0.5], true); // top at 2.25
    slab("lower", 0, -2, [6, 0.5], true); // top at -1.75
    slab("floor", 0, -6, [20, 1], false);
    const { player, cc, frame } = controller(0, 3.3);
    for (let i = 0; i < 60; i++) frame(engine);
    expect(cc.isGrounded).toBe(true);
    expect(player.transform!.worldPosition.y).toBeCloseTo(3.25, 1);
    cc.dropThrough();
    for (let i = 0; i < 180; i++) frame(engine);
    expect(cc.isGrounded).toBe(true);
    expect(player.transform!.worldPosition.y).toBeCloseTo(-0.75, 1);
  });

  it("does nothing to solid ground", async () => {
    const engine = await setup();
    slab("ground", 0, 0, [6, 0.5], false);
    const { b, rb } = crate(0, 1);
    steps(engine, 60);
    rb.dropThrough();
    steps(engine, 60);
    expect(b.transform!.worldPosition.y).toBeCloseTo(0.65, 1);
  });
});
