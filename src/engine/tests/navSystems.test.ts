import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  Assets,
  BoxCollider,
  Engine,
  GameObject,
  NavAgent,
  NavChunk,
  NavGate,
  Navigation,
  Replicated,
  RigidBody,
  SceneManager,
  Vector3,
  type ProjectSettingsInput,
} from "../index";
import { World } from "../core/World";
import { bakeChunk, releaseBakeCaches, type NavBakeMesh } from "../nav/bake";
import { clearNavBakeCache } from "../nav/navigationSystems";
import { chunkIdOf, type Vec3 } from "../nav/runtime";
import { defaultNavAgentType, defaultNavigationSettings, type NavigationSettings } from "../nav/settings";

// ADR 0065, W6: navigation in the engine: components, the built-in systems and the Navigation facade, on a
// headless Engine with a scene whose NavChunk references a bake made here (a floor split by a wall with a gated gap).

const WALKER = "walker";
const SCENE = "scenes/nav.scene.json";
const BAKE = "scenes/nav.nav.bin";
const GATE = "door";

function navSettings(): NavigationSettings {
  const s = defaultNavigationSettings();
  s.agentTypes = [defaultNavAgentType(WALKER, "Walker")];
  return s;
}

const project = (): ProjectSettingsInput => ({ navigation: navSettings(), physics: { gravity: [0, -9.81, 0], layers: ["Default"] } });

function floor(half: number): NavBakeMesh {
  return { positions: new Float32Array([-half, 0, -half, half, 0, -half, half, 0, half, -half, 0, half]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]) };
}

function box(center: Vec3, size: Vec3): NavBakeMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      const base = positions.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = [0, 0, 0];
        p[axis] = center[axis] + (sign * size[axis]) / 2;
        p[u] = center[u] + (a * size[u]) / 2;
        p[v] = center[v] + (b * size[v]) / 2;
        positions.push(...p);
      }
      if (sign > 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices), kind: "obstacle" };
}

let bakeUrl = "";

beforeAll(async () => {
  // A wall along x = 0 with a 3 m gap at z = 0, closed or open by the gate.
  const meshes = [floor(10), box([0, 1, -5.75], [1, 2, 8.5]), box([0, 1, 5.75], [1, 2, 8.5])];
  const gateBox = [1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3.2, 0, 0, 1, 0, 1];
  const baked = await bakeChunk(meshes, navSettings(), SCENE, "chunk", { gates: [{ boxToWorld: gateBox, id: GATE, startOpen: true }] });
  bakeUrl = `data:application/octet-stream;base64,${Buffer.from(baked.bytes).toString("base64")}`;
});

afterAll(() => releaseBakeCaches());

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.restoreAllMocks();
});

interface SceneOptions {
  agents?: { id: string; position: Vec3; data?: Record<string, unknown>; extra?: { type: string; data?: Record<string, unknown> }[] }[];
  physics?: "3d";
  /** Plain nodes (a Transform at `position`), e.g. goals. */
  markers?: { id: string; position: Vec3 }[];
}

function sceneFile(options: SceneOptions) {
  return {
    format: "myco.scene@1",
    ...(options.physics ? { settings: { physics: options.physics } } : {}),
    nodes: [
      { id: "chunk", name: "Chunk", components: [{ type: "engine.NavChunk", data: { bake: `asset:${BAKE}` } }] },
      { id: "gate", name: "Gate", components: [{ type: "engine.Transform", data: { position: [0, 1, 0] } }, { type: "engine.NavGate", data: { gateId: GATE, size: [1.5, 2, 3.2] } }] },
      ...(options.agents ?? []).map((a) => ({
        id: a.id,
        name: a.id,
        components: [{ type: "engine.Transform", data: { position: a.position } }, { type: "engine.NavAgent", data: a.data ?? {} }, ...(a.extra ?? [])],
      })),
      ...(options.markers ?? []).map((m) => ({ id: m.id, name: m.id, components: [{ type: "engine.Transform", data: { position: m.position } }] })),
    ],
  };
}

async function setup(options: SceneOptions = {}) {
  clearNavBakeCache();
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ [SCENE]: sceneFile(options), [BAKE]: bakeUrl }));
  const engine = await Engine.create({ headless: true, project: project() });
  engines.push(engine);
  const scene = await SceneManager.load(SCENE);
  return { engine, scene };
}

const steps = (engine: Engine, n: number) => {
  for (let i = 0; i < n; i++) engine.step(1 / 60);
};

function stepUntil(engine: Engine, done: () => boolean, max = 1200): number {
  for (let i = 0; i < max; i++) {
    if (done()) return i;
    engine.step(1 / 60);
  }
  return max;
}

/** A node by name, anywhere in the current World. */
function find(name: string): GameObject | null {
  const walk = (n: GameObject): GameObject | null => {
    if (n.name === name) return n;
    for (const c of n.children) {
      const f = walk(c);
      if (f) return f;
    }
    return null;
  };
  return walk(World.require().root);
}

const agentOf = (id: string) => find(id)!.getBehavior(NavAgent)!;
const dist = (p: { x: number; y: number; z: number }, q: Vec3) => Math.hypot(p.x - q[0], p.y - q[1], p.z - q[2]);

describe("navigation in the engine (ADR 0065)", () => {
  it("loads the scene's chunk with the scene and walks agents to their destinations through the gap", async () => {
    const { engine } = await setup({ agents: [{ id: "a", position: [-6, 0, -6] }, { id: "b", position: [-6, 0, 6] }] });
    expect(engine.world.navigation).not.toBeNull();
    const chunk = find("Chunk")!.getBehavior(NavChunk)!;
    steps(engine, 1);
    expect(chunk.isLoaded).toBe(true); // preloaded by SceneManager.load: loaded at the first step
    expect(Navigation.loadedChunks).toEqual([await chunkIdOf(SCENE, "chunk")]);

    const a = agentOf("a"), b = agentOf("b");
    a.setDestination([6, 0, 6]);
    b.setDestination({ x: 6, y: 0, z: -6 });
    expect(a.pathState).toBe("none");
    stepUntil(engine, () => a.pathState === "arrived" && b.pathState === "arrived");
    expect(a.pathState).toBe("arrived");
    expect(b.pathState).toBe("arrived");
    expect(dist(a.transform.position, [6, 0, 6])).toBeLessThan(1);
    expect(dist(b.transform.position, [6, 0, -6])).toBeLessThan(1);
    expect(a.remainingDistance).toBeLessThan(1);
    expect(a.mode).toBe("walking");
  });

  it("reports the path, velocity and remaining distance while following", async () => {
    const { engine } = await setup({ agents: [{ id: "a", position: [-6, 0, -6] }] });
    const a = agentOf("a");
    a.setDestination([6, 0, 6]);
    steps(engine, 20);
    expect(a.pathState).toBe("following");
    expect(a.path.length).toBeGreaterThanOrEqual(2);
    expect(a.path[a.path.length - 1].position.x).toBeCloseTo(6, 0);
    expect(a.velocity.length).toBeGreaterThan(0.5);
    expect(a.remainingDistance).toBeGreaterThan(5);
  });

  it("chases a node, stops and warps", async () => {
    const { engine } = await setup({ agents: [{ id: "a", position: [-6, 0, -6] }] });
    const target = GameObject.create("target");
    target.transform!.position.set(-6, 0, 4);
    const a = agentOf("a");
    a.chase(target, 1); // repath once it's 1 m from the goal the path used
    stepUntil(engine, () => dist(a.transform.position, [-6, 0, 4]) < 1.2, 600);
    expect(dist(a.transform.position, [-6, 0, 4])).toBeLessThan(1.2);
    target.transform!.position.set(-2, 0, 8); // it follows
    stepUntil(engine, () => dist(a.transform.position, [-2, 0, 8]) < 1.2, 600);
    expect(dist(a.transform.position, [-2, 0, 8])).toBeLessThan(1.2);

    a.setDestination([-6, 0, -6]);
    steps(engine, 30);
    a.stop();
    steps(engine, 2);
    const stopped = a.transform.position.clone();
    steps(engine, 30);
    expect(dist(a.transform.position, [stopped.x, stopped.y, stopped.z])).toBeLessThan(0.3);
    expect(a.pathState).not.toBe("following");

    a.warp([5, 0, 5]);
    steps(engine, 1);
    expect(dist(a.transform.position, [5, 0, 5])).toBeLessThan(0.1);
  });

  it("heads for its initial goal once, without following it (ADR 0066)", async () => {
    const { engine } = await setup({ agents: [{ id: "a", position: [-6, 0, -6], data: { initialGoal: { $node: "goal" } } }], markers: [{ id: "goal", position: [6, 0, 6] }] });
    const a = agentOf("a");
    expect(a.initialGoal?.name).toBe("goal");
    stepUntil(engine, () => a.pathState === "arrived");
    expect(a.pathState).toBe("arrived");
    expect(dist(a.transform.position, [6, 0, 6])).toBeLessThan(1);
    find("goal")!.transform!.position.set(-6, 0, 6); // a goal, not a chase: it stays
    steps(engine, 120);
    expect(dist(a.transform.position, [6, 0, 6])).toBeLessThan(1);
  });

  it("chases its initial goal with chaseGoal (ADR 0066)", async () => {
    const { engine } = await setup({
      agents: [{ id: "a", position: [-6, 0, -6], data: { initialGoal: { $node: "goal" }, chaseGoal: true, chaseRepathDistance: 1 } }],
      markers: [{ id: "goal", position: [-6, 0, 4] }],
    });
    const a = agentOf("a");
    stepUntil(engine, () => dist(a.transform.position, [-6, 0, 4]) < 1.2, 600);
    expect(dist(a.transform.position, [-6, 0, 4])).toBeLessThan(1.2);
    find("goal")!.transform!.position.set(-2, 0, 8);
    stepUntil(engine, () => dist(a.transform.position, [-2, 0, 8]) < 1.2, 600);
    expect(dist(a.transform.position, [-2, 0, 8])).toBeLessThan(1.2);
  });

  it("lets a script's first command win over the initial goal (ADR 0066)", async () => {
    const { engine } = await setup({ agents: [{ id: "a", position: [-6, 0, -6], data: { initialGoal: { $node: "goal" } } }], markers: [{ id: "goal", position: [6, 0, 6] }] });
    const a = agentOf("a");
    a.setDestination([-6, 0, 6]); // queued before the first sync
    stepUntil(engine, () => a.pathState === "arrived");
    expect(dist(a.transform.position, [-6, 0, 6])).toBeLessThan(1);
  });

  it("chases another agent", async () => {
    const { engine } = await setup({ agents: [{ id: "a", position: [-6, 0, -6] }, { id: "b", position: [-6, 0, 6] }] });
    agentOf("a").chase(find("b")!);
    stepUntil(engine, () => Vector3.distance(find("a")!.transform!.position, find("b")!.transform!.position) < 1.5, 600);
    expect(Vector3.distance(find("a")!.transform!.position, find("b")!.transform!.position)).toBeLessThan(1.5);
  });

  it("closes and opens a gate", async () => {
    const { engine } = await setup({ agents: [{ id: "a", position: [-6, 0, 0] }] });
    const gate = find("Gate")!.getBehavior(NavGate)!;
    steps(engine, 2);
    expect(Navigation.findPath([-6, 0, 0], [6, 0, 0]).status).toBe("success");
    gate.open = false;
    // Queries see the change at once, before a step has synced it (or a tick applied it).
    expect(Navigation.findPath([-6, 0, 0], [6, 0, 0]).status).not.toBe("success");
    steps(engine, 2);
    const a = agentOf("a");
    a.setDestination([6, 0, 0]);
    steps(engine, 300);
    expect(a.transform.position.x).toBeLessThan(0); // the gap is shut
    expect(a.pathState).not.toBe("arrived");
    // One-shot queries respect the gate too.
    expect(Navigation.findPath([-6, 0, 0], [6, 0, 0]).status).not.toBe("success");
    expect(Navigation.raycast([-3, 0, 0], [3, 0, 0])!.hit).toBe(true);
    gate.open = true;
    steps(engine, 2);
    expect(Navigation.findPath([-6, 0, 0], [6, 0, 0]).status).toBe("success");
    a.setDestination([6, 0, 0]);
    stepUntil(engine, () => a.pathState === "arrived");
    expect(dist(a.transform.position, [6, 0, 0])).toBeLessThan(1);
  });

  it("answers facade queries", async () => {
    const { engine } = await setup();
    steps(engine, 2);
    const path = Navigation.findPath([-6, 0, -6], [6, 0, -6]);
    expect(path.status).toBe("success");
    expect(path.waypoints.length).toBeGreaterThanOrEqual(3); // through the gap
    expect(path.waypoints.some((w) => Math.abs(w.position.x) < 1 && Math.abs(w.position.z) < 1.6)).toBe(true);
    expect(path.waypoints[0].normal.y).toBeGreaterThan(0.9);
    expect(Navigation.findPath([-6, 0, -6], [50, 0, 0]).status).toBe("none");

    const near = Navigation.nearestPoint([3, 1, 3], WALKER, 2)!;
    expect(Math.abs(near.point.y)).toBeLessThan(0.3);
    expect(Navigation.nearestPoint([3, 20, 3])).toBeNull();

    const hit = Navigation.raycast([-6, 0, -6], [6, 0, -6])!;
    expect(hit.hit).toBe(true);
    expect(hit.point.x).toBeLessThan(0);
    const clear = Navigation.raycast([-6, 0, -6], [-6, 0, 6])!;
    expect(clear.hit).toBe(false);
    expect(clear.t).toBeCloseTo(1, 3);

    expect(() => Navigation.setAreaCost("mud", 4)).not.toThrow();
    Navigation.debug.paths = true;
    expect(engine.world.navigation!.debug.paths).toBe(true);
  });

  it("removes the chunk when its scene unloads", async () => {
    const { engine, scene } = await setup({ agents: [{ id: "a", position: [-6, 0, -6] }] });
    steps(engine, 2);
    expect(Navigation.loadedChunks).toHaveLength(1);
    const agent = agentOf("a");
    expect(agent._backend).not.toBeNull();
    SceneManager.unload(scene);
    steps(engine, 2);
    expect(Navigation.loadedChunks).toEqual([]);
    expect(agent._backend).toBeNull();
  });

  it("leaves the transform alone with updatePosition off, but fills desiredVelocity", async () => {
    const { engine } = await setup({ agents: [{ id: "a", position: [-6, 0, -6], data: { updatePosition: false, updateRotation: false } }] });
    const a = agentOf("a");
    a.setDestination([6, 0, 6]);
    steps(engine, 30);
    expect(dist(a.transform.position, [-6, 0, -6])).toBeLessThan(1e-6);
    expect(a.desiredVelocity.length).toBeGreaterThan(0.5);
    // Driving the node from desiredVelocity moves the agent with it.
    for (let i = 0; i < 60; i++) {
      a.transform.position.add(a.desiredVelocity.scale(1 / 60));
      engine.step(1 / 60);
    }
    expect(dist(a.transform.position, [-6, 0, -6])).toBeGreaterThan(1.5);
  });

  it("moves an agent with a kinematic RigidBody through physics", async () => {
    const { engine } = await setup({
      physics: "3d",
      agents: [{ id: "a", position: [-6, 0, -6], extra: [{ type: "engine.RigidBody", data: { bodyType: "kinematic" } }, { type: "engine.BoxCollider", data: {} }] }],
    });
    expect(engine.world.physics3D).not.toBeNull();
    const a = agentOf("a");
    a.setDestination([-6, 0, 6]);
    steps(engine, 120);
    const p = a.transform.position;
    expect(p.z).toBeGreaterThan(-4);
    const body = a.node.getBehavior(RigidBody)!._state!.body.translation();
    expect(Math.hypot(body.x - p.x, body.z - p.z)).toBeLessThan(0.2); // the body follows the transform
    expect(a.node.getBehavior(BoxCollider)).not.toBeNull();
  });

  it("doesn't simulate ghosts, nor run in client or editor Worlds", async () => {
    const { engine } = await setup({ agents: [{ id: "a", position: [-6, 0, -6] }] });
    const a = agentOf("a");
    const rep = a.node.addBehavior(Replicated);
    rep._isGhost = true;
    a.setDestination([6, 0, 6]);
    steps(engine, 60);
    expect(a._backend).toBeNull();
    expect(dist(a.transform.position, [-6, 0, -6])).toBeLessThan(1e-6);

    const client = new World("runtime", project(), { name: "Client", tags: ["client"] });
    expect(client.systemNames()).not.toContain("engine.NavSync");
    const editor = new World("editor", project());
    expect(editor.systemNames()).not.toContain("engine.NavStep");
    const server = new World("server", project());
    expect(server.systemNames()).toEqual(expect.arrayContaining(["engine.NavSync", "engine.NavStep", "engine.NavWriteBack"]));
  });

  it("runs before both physics pushes", async () => {
    const { engine } = await setup();
    const order = engine.world.scheduler.order("fixedUpdate");
    const at = (n: string) => order.indexOf(n);
    expect(at("engine.FixedUpdateScripts")).toBeLessThan(at("engine.NavSync"));
    expect(at("engine.NavSync")).toBeLessThan(at("engine.NavStep"));
    expect(at("engine.NavStep")).toBeLessThan(at("engine.NavWriteBack"));
    expect(at("engine.NavWriteBack")).toBeLessThan(at("engine.PhysicsPush"));
    expect(at("engine.NavWriteBack")).toBeLessThan(at("engine.Physics3DPush"));
  });

  it("is deterministic", async () => {
    const run = async () => {
      const { engine } = await setup({ agents: [{ id: "a", position: [-6, 0, -6] }, { id: "b", position: [-6, 0, 6] }, { id: "c", position: [6, 0, 0] }] });
      agentOf("a").setDestination([6, 0, 6]);
      agentOf("b").setDestination([6, 0, -6]);
      agentOf("c").setDestination([-6, 0, 0]);
      const trace: number[] = [];
      for (let i = 0; i < 240; i++) {
        engine.step(1 / 60);
        for (const id of ["a", "b", "c"]) trace.push(...find(id)!.transform!.position.toArray());
      }
      engine.dispose();
      engines.splice(engines.indexOf(engine), 1);
      return trace;
    };
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
  });

  it("returns nothing (with a warning) from queries before navigation loads, and starts it for agents added in code", async () => {
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ "empty.json": { format: "myco.scene@1", nodes: [] } }));
    const engine = await Engine.create({ headless: true, project: project() });
    engines.push(engine);
    await SceneManager.load("empty.json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(engine.world.navigation).toBeNull();
    expect(Navigation.findPath([0, 0, 0], [1, 0, 1])).toEqual({ status: "none", waypoints: [] });
    expect(Navigation.raycast([0, 0, 0], [1, 0, 1])).toBeNull();
    expect(Navigation.isReady).toBe(false);
    expect(warn.mock.calls.some((c) => /before navigation loaded/.test(String(c[0])))).toBe(true);

    const node = GameObject.create("agent");
    node.addBehavior(NavAgent);
    await vi.waitFor(() => expect(engine.world.navigation).not.toBeNull());
    expect(Navigation.isReady).toBe(true);
  });
});
