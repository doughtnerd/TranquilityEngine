/**
 * Navigation benchmarks (ADR 0065), through the TypeScript runtime and the WebAssembly module.
 * Run: `npm run bench -- bench/nav.bench.ts`. Fixtures are built in the (untimed) `setup` of each bench and
 * only the current one is kept alive.
 *
 * - Bake: one 64 x 64 m chunk (a floor and 30 boxes), cold and incremental (one box moved per rebake).
 * - Runtime tick: `NavigationRuntime.tick` alone, 500 / 2,000 walkers and 300 flyers with random destinations.
 * - Engine step: `engine.step` with N NavAgent nodes (NavSync + NavStep + NavWriteBack), for the TS-side overhead.
 * - Queries: `findPath` throughput on the baked chunk.
 */
import { afterAll, describe, test } from "vitest";
import { Assets, Engine, GameObject, NavAgent, SceneManager, type ProjectSettingsInput } from "../src/engine/index";
import { World } from "../src/engine/core/World";
import { bakeChunk, releaseBakeCaches, type NavBakeMesh } from "../src/engine/nav/bake";
import { clearNavBakeCache } from "../src/engine/nav/navigationSystems";
import { NavigationRuntime, chunkIdOf, type Vec3 } from "../src/engine/nav/runtime";
import { defaultNavAgentType, defaultNavigationSettings, type NavigationSettings } from "../src/engine/nav/settings";

const WALKER = "walker";
const FLYER = "flyer";
const SCENE = "scenes/bench.scene.json";
const BAKE = "scenes/bench.nav.bin";
const CHUNK = "chunk";
const HALF = 32;
const DT = 1 / 60;
const OPTS = { time: 2000, warmupTime: 500, iterations: 10, warmupIterations: 3 } as const;

function navSettings(): NavigationSettings {
  const s = defaultNavigationSettings();
  const flyer = defaultNavAgentType(FLYER, "Flyer");
  flyer.canWalk = false;
  flyer.canFly = true;
  s.agentTypes = [defaultNavAgentType(WALKER, "Walker"), flyer];
  return s;
}

// A small seeded generator, so every run bakes and steers the same scene.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

/** 30 boxes (2-6 m wide, 2-6 m tall) scattered over the chunk; `moved` shifts box 0 by 3 m. */
function boxSpecs(moved = false): { x: number; z: number; w: number; d: number; h: number }[] {
  const r = rng(7);
  return Array.from({ length: 30 }, (_, i) => {
    const w = 2 + r() * 4, d = 2 + r() * 4, h = 2 + r() * 4;
    const x = (r() * 2 - 1) * (HALF - 4) + (moved && i === 0 ? 3 : 0);
    const z = (r() * 2 - 1) * (HALF - 4);
    return { x, z, w, d, h };
  });
}

/** A floor with 30 boxes. */
function sceneMeshes(moved = false): NavBakeMesh[] {
  return [floor(HALF), ...boxSpecs(moved).map((b) => box([b.x, b.h / 2, b.z], [b.w, b.h, b.d]))];
}

const SPECS = boxSpecs();

/** A random point on the floor, away from the edge and 1.5 m clear of every box (flyers: `y` above the boxes). */
function randomPoint(r: () => number, y = 0): Vec3 {
  for (;;) {
    const x = (r() * 2 - 1) * (HALF - 3), z = (r() * 2 - 1) * (HALF - 3);
    if (y === 0 && SPECS.some((b) => Math.abs(x - b.x) < b.w / 2 + 1.5 && Math.abs(z - b.z) < b.d / 2 + 1.5)) continue;
    return [x, y, z];
  }
}

/** Every agent gets a new random destination this often (steps), staggered, so the crowd stays busy. */
const RETARGET = 300;

// ------------------------------------------------------------------------------------------------ harness

interface Opts { time: number; warmupTime: number; iterations: number; warmupIterations: number; setup?: () => void | Promise<void> }
const rows: { name: string; ops: number; meanMs: number; p99Ms: number; samples: number }[] = [];

/** Vitest 5's benchmark API: `bench` comes from the test context. Setup runs untimed before the measurement. */
function bench(name: string, fn: () => void | Promise<void>, opts: Opts): void {
  test(name, async ({ bench: b }) => {
    await opts.setup?.();
    const r = await b(name, fn).run({ time: opts.time, warmupTime: opts.warmupTime, iterations: opts.iterations, warmupIterations: opts.warmupIterations });
    rows.push({ name, ops: r.throughput.mean, meanMs: r.latency.mean, p99Ms: r.latency.p99, samples: r.latency.samplesCount });
  }, 600_000);
}

afterAll(() => {
  releaseBakeCaches();
  console.log("\nNavigation benchmark results");
  console.log("| scenario | ops/s | mean ms/op | p99 ms | samples |\n|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.name} | ${r.ops.toFixed(1)} | ${r.meanMs.toFixed(4)} | ${r.p99Ms.toFixed(4)} | ${r.samples} |`);
});

let bakedBytes: Uint8Array | null = null;
async function baked(): Promise<Uint8Array> {
  bakedBytes ??= (await bakeChunk(sceneMeshes(), navSettings(), SCENE, CHUNK)).bytes;
  return bakedBytes;
}

// ------------------------------------------------------------------------------------------------ bake

let coldMeshes: NavBakeMesh[] = [];
let staticMeshes: NavBakeMesh[] = [];
let movedMeshes: NavBakeMesh[] = [];
let flip = false;

describe("bake: 64 x 64 m chunk, 30 boxes", () => {
  bench("bake cold", async () => {
    releaseBakeCaches(SCENE, "cold");
    await bakeChunk(coldMeshes, navSettings(), SCENE, "cold");
  }, { ...OPTS, setup: () => { coldMeshes = sceneMeshes(); } });

  bench("bake incremental (one box moved)", async () => {
    flip = !flip;
    await bakeChunk(flip ? movedMeshes : staticMeshes, navSettings(), SCENE, "inc");
  }, {
    ...OPTS,
    setup: async () => {
      staticMeshes = sceneMeshes();
      movedMeshes = sceneMeshes(true);
      releaseBakeCaches(SCENE, "inc");
      await bakeChunk(staticMeshes, navSettings(), SCENE, "inc"); // the cache to reuse
    },
  });
});

// ------------------------------------------------------------------------------------------------ runtime.tick

interface RtFixture { key: string; rt: NavigationRuntime }
let rtCurrent: RtFixture | null = null;
let tickTime = 0;
let tickCount = 0;
let handleList: number[] = [];
let walkerCount = 0;
const retargetRandom = rng(19);

function runtimeFixture(key: string, walkers: number, flyers: number): () => Promise<void> {
  return async () => {
    if (rtCurrent?.key === key) return;
    rtCurrent?.rt.dispose();
    rtCurrent = null;
    const rt = await NavigationRuntime.create(navSettings());
    rt.loadChunk(await chunkIdOf(SCENE, CHUNK), await baked());
    const r = rng(11);
    const handles: number[] = [];
    for (let i = 0; i < walkers; i++) handles.push(rt.addAgent({ agentType: WALKER, position: randomPoint(r) }));
    for (let i = 0; i < flyers; i++) handles.push(rt.addAgent({ agentType: FLYER, position: randomPoint(r, 8) }));
    tickTime = 0;
    rt.tick(DT, (tickTime += DT)); // agents go live, the chunk loads
    rt.tick(DT, (tickTime += DT));
    handles.forEach((h, i) => rt.setDestination(h, randomPoint(r, i < walkers ? 0 : 8)));
    handleList = handles;
    walkerCount = walkers;
    tickCount = 0;
    rtCurrent = { key, rt };
  };
}

for (const [name, walkers, flyers] of [["500 walkers", 500, 0], ["2,000 walkers", 2000, 0], ["300 flyers", 0, 300]] as const) {
  describe(`runtime.tick, ${name}`, () => {
    bench(`runtime.tick ${name}`, () => {
      // The tick is the measured part; the few destination changes keep agents moving rather than all arrived.
      for (let i = tickCount++ % RETARGET; i < handleList.length; i += RETARGET) rtCurrent!.rt.setDestination(handleList[i], randomPoint(retargetRandom, i < walkerCount ? 0 : 8));
      rtCurrent!.rt.tick(DT, (tickTime += DT));
    }, { ...OPTS, setup: runtimeFixture(name, walkers, flyers) });
  });
}

// ------------------------------------------------------------------------------------------------ engine.step

const project = (): ProjectSettingsInput => ({ navigation: navSettings(), physics: { gravity: [0, -9.81, 0], layers: ["Default"] } });

interface EngineFixture { key: string; engine: Engine }
let engCurrent: EngineFixture | null = null;
let engAgents: NavAgent[] = [];
let engCount = 0;

function engineFixture(n: number): () => Promise<void> {
  return async () => {
    const key = `engine-${n}`;
    if (engCurrent?.key === key) return;
    engCurrent?.engine.dispose();
    engCurrent = null;
    const r = rng(13);
    const nodes: unknown[] = [{ id: "chunk", name: "Chunk", components: [{ type: "engine.NavChunk", data: { bake: `asset:${BAKE}` } }] }];
    for (let i = 0; i < n; i++) {
      nodes.push({ id: `a${i}`, name: `a${i}`, components: [{ type: "engine.Transform", data: { position: randomPoint(r) } }, { type: "engine.NavAgent", data: { agentType: WALKER } }] });
    }
    const bytes = await baked();
    clearNavBakeCache();
    Assets.clearSources();
    Assets.addSource(Assets.fromObject({ [SCENE]: { format: "myco.scene@1", nodes }, [BAKE]: `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}` }));
    const engine = await Engine.create({ headless: true, project: project() });
    await SceneManager.load(SCENE);
    engine.step(DT);
    engine.step(DT);
    const agents: NavAgent[] = [];
    const walk = (node: GameObject) => {
      const a = node.getBehavior(NavAgent);
      if (a) agents.push(a);
      for (const c of node.children) walk(c);
    };
    walk(World.require().root);
    for (const a of agents) a.setDestination(randomPoint(r));
    engAgents = agents;
    engCount = 0;
    engine.step(DT);
    engCurrent = { key, engine };
  };
}

for (const n of [500, 2000]) {
  describe(`engine.step, ${n} NavAgents`, () => {
    bench(`engine.step ${n} NavAgents (walkers)`, () => {
      for (let i = engCount++ % RETARGET; i < engAgents.length; i += RETARGET) engAgents[i].setDestination(randomPoint(retargetRandom));
      engCurrent!.engine.step(DT);
    }, { ...OPTS, setup: engineFixture(n) });
  });
}

// ------------------------------------------------------------------------------------------------ queries

describe("queries", () => {
  let pairs: [Vec3, Vec3][] = [];
  let i = 0;
  bench("findPath (walker, random pairs)", () => {
    const [a, b] = pairs[i++ % pairs.length];
    rtCurrent!.rt.findPath(WALKER, a, b);
  }, {
    ...OPTS,
    setup: async () => {
      await runtimeFixture("queries", 0, 0)();
      const r = rng(17);
      pairs = Array.from({ length: 256 }, () => [randomPoint(r), randomPoint(r)]);
      const ok = pairs.filter(([a, b]) => rtCurrent!.rt.findPath(WALKER, a, b).status === "success").length;
      process.stderr.write(`[nav bench] findPath: ${ok}/${pairs.length} random pairs succeed\n`);
    },
  });
});
