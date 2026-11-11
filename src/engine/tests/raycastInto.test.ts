// ADR 0162 C14 (task D0): the allocation-free, exclusion-aware ray query the audio occlusion pass uses.
import { beforeEach, describe, expect, it } from "vitest";
import { Assets, BoxCollider, CapsuleCollider, Engine, GameObject, SceneManager } from "../../myco";
import { raycastInto, rayGroupsFor, type WorldRayInto, type WorldRayQuery } from "../core/worldServices";
import { PhysicsWorld3D } from "../../plugins/physics/runtime/core/PhysicsWorld3D";
import { RapierWorld3D } from "../../plugins/physics-rapier/runtime/rapier3d";
import { PHYSICS_3D_SERVICE } from "../../plugins/physics/runtime/systems3d";

const project = { physics: { gravity: [0, -10] as [number, number], layers: ["Default", "Walls", "Ghost"], collisionMatrix: { Default: ["Default", "Walls", "Ghost"] } } };

async function setup(settings: Record<string, unknown> = { physics: "3d" }) {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings, nodes: [] } }));
  const engine = await Engine.create({ headless: true, project });
  await SceneManager.load("s.json");
  return engine;
}

const newOut = (): WorldRayInto => ({ node: null, distance: -1, point: { x: 0, y: 0, z: 0 } });
const query = (over: Partial<WorldRayQuery> = {}): WorldRayQuery => ({ groups: undefined, excludeNodes: new Set(), includeSensors: false, ...over });
const O = { x: 0, y: 0, z: 0 };
const X = { x: 1, y: 0, z: 0 };

function wall(name: string, x: number, collider: Record<string, unknown> = {}): GameObject {
  const n = GameObject.create(name);
  n.transform!.position.x = x;
  n.addBehavior(BoxCollider, collider as never).size.set(0.5, 4, 4);
  return n;
}

let engine: Engine;
beforeEach(async () => {
  engine = await setup();
});
const step = () => engine.step(1 / 60);

describe("raycastInto (C14)", () => {
  it("writes the first hit into out", () => {
    wall("near", 5);
    wall("far", 9);
    step();
    const out = newOut();
    expect(raycastInto(engine.world, out, O, X, 100, query())).toBe(true);
    expect(out.node?.name).toBe("near");
    expect(out.distance).toBeCloseTo(4.75, 3);
    expect(out.point.x).toBeCloseTo(4.75, 3);
    expect(raycastInto(engine.world, out, O, { x: -1, y: 0, z: 0 }, 100, query())).toBe(false);
    expect(raycastInto(engine.world, out, O, X, 3, query())).toBe(false); // too short
  });

  it("accepts a ray direction that is not unit length", () => {
    wall("near", 5);
    step();
    const out = newOut();
    expect(raycastInto(engine.world, out, O, { x: 10, y: 0, z: 0 }, 100, query())).toBe(true);
    expect(out.distance).toBeCloseTo(4.75, 3);
  });

  it("never hits the source's own capsule: collider on the node and on a descendant, ray from inside", () => {
    const source = GameObject.create("source");
    source.addBehavior(CapsuleCollider);
    const child = GameObject.create("child", { parent: source });
    child.addBehavior(CapsuleCollider);
    const listener = GameObject.create("listener");
    listener.addBehavior(BoxCollider);
    step();
    const out = newOut();
    // Without exclusion the ray starts inside the capsules and reports them.
    expect(raycastInto(engine.world, out, O, X, 50, query())).toBe(true);
    // Excluding the source subtree and the listener: nothing.
    const excludeNodes = new Set<GameObject>([source, child, listener]);
    expect(raycastInto(engine.world, out, O, X, 50, query({ excludeNodes }))).toBe(false);
  });

  it("excludes inside the query: a wall behind an excluded collider is still found", () => {
    const own = wall("own", 2);
    wall("blocker", 6);
    step();
    const out = newOut();
    expect(raycastInto(engine.world, out, O, X, 50, query())?.valueOf()).toBe(true);
    expect(out.node?.name).toBe("own");
    expect(raycastInto(engine.world, out, O, X, 50, query({ excludeNodes: new Set([own]) }))).toBe(true);
    expect(out.node?.name).toBe("blocker");
    expect(out.distance).toBeCloseTo(5.75, 3);
  });

  it("never hits sensors", () => {
    wall("zone", 2, { isTrigger: true });
    wall("solid", 6);
    step();
    const out = newOut();
    expect(raycastInto(engine.world, out, O, X, 50, query())).toBe(true);
    expect(out.node?.name).toBe("solid");
  });

  it("respects layer groups", () => {
    wall("ghost", 2, { layer: "Ghost" });
    wall("wallLayer", 6, { layer: "Walls" });
    step();
    const out = newOut();
    const walls = rayGroupsFor(engine.world, ["Walls"]);
    expect(raycastInto(engine.world, out, O, X, 50, query({ groups: walls }))).toBe(true);
    expect(out.node?.name).toBe("wallLayer");
    const ghost = rayGroupsFor(engine.world, ["Ghost"]);
    expect(raycastInto(engine.world, out, O, X, 50, query({ groups: ghost }))).toBe(true);
    expect(out.node?.name).toBe("ghost");
    expect(raycastInto(engine.world, out, O, X, 50, query({ groups: undefined }))).toBe(true);
    expect(out.node?.name).toBe("ghost");
    expect(rayGroupsFor(engine.world)).toBeUndefined();
    expect(() => rayGroupsFor(engine.world, ["Nope"])).toThrow(/unknown physics layer/);
  });

  it("leaves out untouched on a miss", () => {
    step();
    const out = newOut();
    expect(raycastInto(engine.world, out, O, X, 50, query())).toBe(false);
    expect(out).toEqual({ node: null, distance: -1, point: { x: 0, y: 0, z: 0 } });
  });

  it("answers false without the 3D service, and never starts it", async () => {
    const e2 = await setup({ physics: "2d" });
    const out = newOut();
    expect(raycastInto(e2.world, out, O, X, 50, query())).toBe(false);
    expect(e2.world.service(PHYSICS_3D_SERVICE.id)).toBeNull();
  });

  it("makes no allocation on its call path (structural check)", () => {
    // The path: core raycastInto, the service entry, PhysicsWorld3D.raycastInto, the backend's raycastInto and the
    // two predicates. None may hold an object or array literal, a closure, `new`, spread or a template.
    const backend = (PhysicsWorld3D.prototype as unknown as { raycastInto: unknown }).raycastInto;
    const sources = [raycastInto, PHYSICS_3D_SERVICE.raycastInto, backend, RapierWorld3D.prototype.raycastInto].map((f) => String(f));
    for (const src of sources) {
      // An arrow entry point is the function itself, made once: only what's inside it counts.
      const body = src.replace(/\/\/.*$/gm, "").replace(/^\([^)]*\)\s*=>/, "");
      expect(body, body).not.toMatch(/\bnew\b|=>|\bfunction\s*\(|(?<![\w\])])\[|\.\.\.|`|\{\s*\w+\s*:|Math\.hypot\(\.\.\./);
    }
  });
});

