import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, NavAgent, NavCostVolume, Navigation, SceneManager, type ProjectSettingsInput } from "../index";
import { World } from "../core/World";
import { bakeChunk, releaseBakeCaches, type NavBakeMesh } from "../nav/bake";
import { costSegments, RuntimeNavOverlay, NO_NAV_DEBUG, type NavDebugColors } from "../nav/debugGeometry";
import { clearNavBakeCache } from "../nav/navigationSystems";
import { describeNavCostVolume } from "../nav/plan";
import type { Vec3 } from "../nav/runtime";
import { defaultNavAgentType, defaultNavigationSettings, type NavigationSettings } from "../nav/settings";

// ADR 0070: NavCostVolume changes path costs at runtime without a rebake. A floor split by a wall along x = 0 with a
// near gap (z in [-1.5, 1.5]) and a far one (z in [5.5, 8.5]).

const WALKER = "walker";
const FLYER = "flyer";
const SCENE = "scenes/costs.scene.json";
const BAKE = "scenes/costs.nav.bin";

function navSettings(): NavigationSettings {
  const s = defaultNavigationSettings();
  const flyer = defaultNavAgentType(FLYER, "Flyer");
  flyer.canWalk = false;
  flyer.canFly = true;
  s.agentTypes = [defaultNavAgentType(WALKER, "Walker"), flyer];
  return s;
}

const project = (): ProjectSettingsInput => ({ navigation: { ...navSettings(), agentTypes: [defaultNavAgentType(WALKER, "Walker")] } });

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
  const meshes = [floor(10), box([0, 1, -5.75], [1, 2, 8.5]), box([0, 1, 3.5], [1, 2, 4]), box([0, 1, 9.25], [1, 2, 1.5])];
  const s = navSettings();
  s.agentTypes = [s.agentTypes[0]];
  const baked = await bakeChunk(meshes, s, SCENE, "chunk");
  bakeUrl = `data:application/octet-stream;base64,${Buffer.from(baked.bytes).toString("base64")}`;
});

afterAll(() => releaseBakeCaches());

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
});

async function setup(volume?: Record<string, unknown>) {
  clearNavBakeCache();
  Assets.clearSources();
  const scene = {
    format: "myco.scene@1",
    nodes: [
      { id: "chunk", name: "Chunk", components: [{ type: "engine.NavChunk", data: { bake: `asset:${BAKE}` } }] },
      { id: "a", name: "a", components: [{ type: "engine.Transform", data: { position: [-6, 0, 0] } }, { type: "engine.NavAgent", data: {} }] },
      ...(volume ? [{ id: "fog", name: "Fog", components: [{ type: "engine.Transform", data: { position: [0, 0, 0] } }, { type: "engine.NavCostVolume", data: volume }] }] : []),
    ],
  };
  Assets.addSource(Assets.fromObject({ [SCENE]: scene, [BAKE]: bakeUrl }));
  const engine = await Engine.create({ headless: true, project: project() });
  engines.push(engine);
  await SceneManager.load(SCENE);
  return engine;
}

const steps = (engine: Engine, n: number) => {
  for (let i = 0; i < n; i++) engine.step(1 / 60);
};

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

const throughNearGap = (path: ReturnType<typeof Navigation.findPath>) => path.waypoints.every((w) => Math.abs(w.position.z) < 2);
const throughFarGap = (path: ReturnType<typeof Navigation.findPath>) => path.waypoints.some((w) => w.position.z > 5);

describe("NavCostVolume (ADR 0070)", () => {
  it("re-routes one-shot queries at once and walking agents on the next step, and stops when removed", async () => {
    const engine = await setup();
    steps(engine, 2);
    const from: Vec3 = [-6, 0, 0], to: Vec3 = [6, 0, 0];
    expect(throughNearGap(Navigation.findPath(from, to))).toBe(true);

    const agent = find("a")!.getBehavior(NavAgent)!;
    agent.setDestination(to);
    steps(engine, 10);
    expect(agent.path.every((w) => Math.abs(w.position.z) < 2)).toBe(true);

    const fog = GameObject.create("fog");
    const volume = fog.addComponent(NavCostVolume, { cost: 50 });
    volume.size.set(3, 4, 3);
    expect(volume.cost).toBe(50);
    // Queries see a volume added this frame.
    expect(throughFarGap(Navigation.findPath(from, to))).toBe(true);
    steps(engine, 2);
    expect(agent.path.some((w) => w.position.z > 5)).toBe(true); // re-planned round the fog
    let maxZ = -Infinity;
    for (let i = 0; i < 900 && agent.pathState !== "arrived"; i++) {
      engine.step(1 / 60);
      maxZ = Math.max(maxZ, agent.transform.position.z);
    }
    expect(agent.pathState).toBe("arrived");
    expect(maxZ).toBeGreaterThan(5);

    GameObject.destroy(fog);
    steps(engine, 1);
    expect(throughNearGap(Navigation.findPath(to, from))).toBe(true);
  });

  it("excludes, follows its node, and does nothing while disabled or for other agent types", async () => {
    const engine = await setup({ size: [3, 4, 3], excluded: true });
    steps(engine, 2);
    const from: Vec3 = [-6, 0, 0], to: Vec3 = [6, 0, 0];
    const volume = find("Fog")!.getBehavior(NavCostVolume)!;
    expect(throughFarGap(Navigation.findPath(from, to))).toBe(true);

    volume.enabled = false;
    expect(throughNearGap(Navigation.findPath(from, to))).toBe(true);
    volume.enabled = true;
    expect(throughFarGap(Navigation.findPath(from, to))).toBe(true);

    volume.agents = [FLYER];
    expect(throughNearGap(Navigation.findPath(from, to))).toBe(true);
    volume.agents = [WALKER];
    expect(throughFarGap(Navigation.findPath(from, to))).toBe(true);

    // Moved off the gap with its node: the gap opens again.
    find("Fog")!.transform!.position.set(-6, 0, -8);
    steps(engine, 1);
    expect(throughNearGap(Navigation.findPath(from, to))).toBe(true);
  });

  it("draws the polygons it changes when Navigation.debug.costs is on", async () => {
    const engine = await setup({ size: [3, 4, 3], cost: 50 });
    steps(engine, 2);
    const nav = engine.world.navigation!;
    const chunk = nav.loadedChunks()[0];
    const lines = nav.runtime.debugCosts(chunk, WALKER);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length % 7).toBe(0);
    for (let i = 6; i < lines.length; i += 7) expect(lines[i]).toBe(50);

    const colors: NavDebugColors = { outline: 1, shared: 2, fold: 3, jump: 4, chunkFace: 5, volume: 6, landing: 7, seam: 8, path: 9, costly: 10, cheap: 11, excluded: 12 };
    Navigation.debug.costs = true;
    expect(nav.debug.costs).toBe(true);
    const overlay = new RuntimeNavOverlay(nav.runtime, () => nav.loadedChunks(), () => [WALKER], () => ({ ...NO_NAV_DEBUG, costs: nav.debug.costs }), () => colors);
    const segs = overlay.segments();
    expect(segs.map((s) => s.color)).toEqual([10]);
    expect(segs[0].positions.length / 6).toBe(lines.length / 7);
  });
});

describe("cost volume helpers", () => {
  it("buckets cost outlines by multiplier", () => {
    const row = (m: number) => [0, 0, 0, 1, 0, 0, m];
    const segs = costSegments(Float32Array.from([...row(4), ...row(0.5), ...row(Infinity), ...row(1), ...row(2)]), { costly: 1, cheap: 2, excluded: 3 });
    expect(segs.map((s) => [s.color, s.positions.length / 6])).toEqual([
      [3, 1],
      [1, 2],
      [2, 1],
    ]);
  });

  it("describes what a volume does in the Inspector", () => {
    const s = navSettings();
    const all = describeNavCostVolume(s, { cost: 4, excluded: false, agents: [], domain: "both" });
    expect(all.summary).toContain("by 4");
    expect(all.summary).toContain("every agent type");
    expect(all.warnings).toEqual([]);
    const ex = describeNavCostVolume(s, { cost: 4, excluded: true, agents: [WALKER], domain: "ground" });
    expect(ex.summary).toContain("impassable");
    expect(ex.summary).toContain("Walker");
    const odd = describeNavCostVolume(s, { cost: 1, excluded: false, agents: [FLYER, "nobody"], domain: "ground" });
    expect(odd.warnings).toEqual(["Flyer doesn't walk: this volume doesn't affect it.", 'Unknown agent type "nobody": it\'s ignored.', "A cost of 1 does nothing."]);
  });
});
