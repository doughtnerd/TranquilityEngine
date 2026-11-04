/**
 * ECS core benchmarks (ADR 0012's never-run spike, measured on the in-house sparse-set store).
 * Run: `npm run bench`. Each scenario is timed at N = 1k, 10k and 50k entities; fixtures are built
 * in the (untimed) `setup` of each bench and only the current fixture is kept alive.
 *
 * User systems are global (defineSystem registers by name), so each is gated by a flag in `on`;
 * a gated-off system never iterates its rows, so it costs nothing beyond the scheduler call.
 */
import { afterAll, describe, test } from "vitest";
import { Engine, GameObject, Transform, defineComponent, defineSystem, f32 } from "../src/engine/index";

const Agent = defineComponent("bench.Agent", { x: f32, y: f32, z: f32, vx: f32, vy: f32, vz: f32, speed: f32 });
const Target = defineComponent("bench.Target", { x: f32, y: f32, z: f32 });
const Mover = defineComponent("bench.Mover", { dx: f32 });
const Sparse = defineComponent("bench.Sparse", { v: f32 });
const Other = defineComponent("bench.Other", { v: f32 });
const Extra = defineComponent("bench.Extra", { v: f32 });

const on = { seek: false, seekColumns: false, move: false, sparse: false };
let checksum = 0;

defineSystem({
  name: "bench.Seek",
  phase: "update",
  query: [Agent, Target],
  run(rows, ctx) {
    if (!on.seek) return;
    const dt = ctx.dt;
    let sum = 0;
    for (const r of rows) {
      const a = r.agent as Record<string, number>;
      const t = r.target as Record<string, number>;
      let dx = t.x - a.x, dy = t.y - a.y, dz = t.z - a.z;
      const inv = 1 / (Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6);
      dx *= inv; dy *= inv; dz *= inv;
      const s = a.speed * dt;
      a.vx += dx * s; a.vy += dy * s; a.vz += dz * s;
      a.x += a.vx * dt; a.y += a.vy * dt; a.z += a.vz * dt;
      sum += a.x;
    }
    checksum += sum;
  },
});

// The same seek through typed-array columns (ADR 0064).
defineSystem({
  name: "bench.SeekColumns",
  phase: "update",
  query: [Agent, Target],
  run(rows, ctx) {
    if (!on.seekColumns) return;
    const dt = ctx.dt;
    const a = rows.column(Agent);
    const t = rows.column(Target);
    let sum = 0;
    for (const i of rows.indices) {
      let dx = t.x[i] - a.x[i], dy = t.y[i] - a.y[i], dz = t.z[i] - a.z[i];
      const inv = 1 / (Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6);
      dx *= inv; dy *= inv; dz *= inv;
      const s = a.speed[i] * dt;
      a.vx[i] += dx * s; a.vy[i] += dy * s; a.vz[i] += dz * s;
      a.x[i] += a.vx[i] * dt; a.y[i] += a.vy[i] * dt; a.z[i] += a.vz[i] * dt;
      sum += a.x[i];
    }
    checksum += sum;
  },
});

defineSystem({
  name: "bench.MoveTransforms",
  phase: "update",
  query: [Transform, Mover],
  run(rows, ctx) {
    if (!on.move) return;
    for (const r of rows) {
      const p = (r.transform as Transform).position;
      p.x += (r.mover as Record<string, number>).dx * ctx.dt;
    }
  },
});

defineSystem({
  name: "bench.SparseQuery",
  phase: "update",
  query: [Sparse],
  run(rows) {
    if (!on.sparse) return;
    let sum = 0;
    for (const r of rows) sum += (r.sparse as Record<string, number>).v;
    checksum += sum;
  },
});

interface Opts { time: number; warmupTime: number; iterations: number; warmupIterations: number; setup?: () => void | Promise<void> }
const rows: { name: string; ops: number; meanMs: number; p99Ms: number; samples: number }[] = [];

/** Vitest 5's benchmark API: `bench` comes from the test context. Setup runs untimed before the measurement. */
function bench(name: string, fn: () => void, opts: Opts): void {
  test(name, async ({ bench: b }) => {
    await opts.setup?.();
    const r = await b(name, fn).run({ time: opts.time, warmupTime: opts.warmupTime, iterations: opts.iterations, warmupIterations: opts.warmupIterations });
    rows.push({ name, ops: r.throughput.mean, meanMs: r.latency.mean, p99Ms: r.latency.p99, samples: r.latency.samplesCount });
  }, 600_000);
}

afterAll(() => {
  console.log("\nECS benchmark results (checksum " + checksum.toExponential(3) + ")");
  console.log("| scenario | ops/s | mean ms/op | p99 ms | samples |\n|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.name} | ${r.ops.toFixed(1)} | ${r.meanMs.toFixed(4)} | ${r.p99Ms.toFixed(4)} | ${r.samples} |`);
});

const SIZES = [1000, 10000, 50000];
const DT = 1 / 60;
const OPTS = { time: 1500, warmupTime: 300, iterations: 10, warmupIterations: 3 } as const;

interface Fixture {
  key: string;
  engine: Engine;
  nodes: GameObject[];
  extra?: unknown;
}
let current: Fixture | null = null;

function fixture(key: string, build: (engine: Engine) => Pick<Fixture, "nodes" | "extra">): () => Promise<void> {
  return async () => {
    if (current?.key === key) return;
    current?.engine.dispose();
    current = null;
    on.seek = on.seekColumns = on.move = on.sparse = false;
    const engine = await Engine.create({ headless: true });
    const built = build(engine);
    current = { key, engine, ...built };
    engine.step(DT); // settle (start/awake, first propagation)
  };
}

function cur(): Fixture {
  return current!;
}

function makeAgents(n: number, parent?: GameObject): GameObject[] {
  const nodes: GameObject[] = [];
  for (let i = 0; i < n; i++) {
    const g = GameObject.create("a", parent ? { parent } : {});
    g.addData(Agent, { x: i % 100, y: (i >> 3) % 50, z: 0, speed: 5 });
    g.addData(Target, { x: 500, y: 300, z: 100 });
    nodes.push(g);
  }
  return nodes;
}

describe("a. step fixed overhead (zero entities)", () => {
  bench("engine.step, empty world", () => { cur().engine.step(DT); }, { ...OPTS, setup: fixture("empty", () => ({ nodes: [] })) });
});

for (const n of SIZES) {
  describe(`a. agent steering through engine.step, N=${n}`, () => {
    bench(`seek system via step N=${n}`, () => { cur().engine.step(DT); }, {
      ...OPTS,
      setup: fixture(`seek${n}`, () => { on.seek = true; return { nodes: makeAgents(n) }; }),
    });
    bench(`seek system with columns via step N=${n}`, () => { cur().engine.step(DT); }, {
      ...OPTS,
      setup: fixture(`seekColumns${n}`, () => { on.seekColumns = true; return { nodes: makeAgents(n) }; }),
    });
  });

  describe(`b. raw SoA baseline, N=${n}`, () => {
    const f = () => new Float32Array(n);
    let S: Record<string, Float32Array>;
    bench(`raw Float32Array seek N=${n}`, () => {
      const { x, y, z, vx, vy, vz, speed, tx, ty, tz } = S;
      const dt = DT;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        let dx = tx[i] - x[i], dy = ty[i] - y[i], dz = tz[i] - z[i];
        const inv = 1 / (Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6);
        dx *= inv; dy *= inv; dz *= inv;
        const s = speed[i] * dt;
        vx[i] += dx * s; vy[i] += dy * s; vz[i] += dz * s;
        x[i] += vx[i] * dt; y[i] += vy[i] * dt; z[i] += vz[i] * dt;
        sum += x[i];
      }
      checksum += sum;
    }, {
      ...OPTS,
      setup() {
        S = { x: f(), y: f(), z: f(), vx: f(), vy: f(), vz: f(), speed: f(), tx: f(), ty: f(), tz: f() };
        for (let i = 0; i < n; i++) { S.x[i] = i % 100; S.y[i] = (i >> 3) % 50; S.speed[i] = 5; S.tx[i] = 500; S.ty[i] = 300; S.tz[i] = 100; }
      },
    });
  });

  describe(`c. transform-only nodes, N=${n}`, () => {
    bench(`flat: move N nodes + propagate N=${n}`, () => { cur().engine.step(DT); }, {
      ...OPTS,
      setup: fixture(`flat${n}`, () => {
        on.move = true;
        const nodes: GameObject[] = [];
        for (let i = 0; i < n; i++) { const g = GameObject.create("n"); g.addData(Mover, { dx: 1 }); nodes.push(g); }
        return { nodes };
      }),
    });
    bench(`hierarchy depth 5 (chains): move N nodes + propagate N=${n}`, () => { cur().engine.step(DT); }, {
      ...OPTS,
      setup: fixture(`chain${n}`, () => {
        on.move = true;
        const nodes: GameObject[] = [];
        let parent: GameObject | null = null;
        for (let i = 0; i < n; i++) {
          const g: GameObject = GameObject.create("n", parent && i % 5 !== 0 ? { parent } : {});
          g.addData(Mover, { dx: 1 });
          nodes.push(g);
          parent = g;
        }
        return { nodes };
      }),
    });
  });

  describe(`e. churn, N=${n}`, () => {
    const k = Math.max(1, Math.floor(n / 100));
    // Nodes under a scene node, as in a game. (Created with no parent and no scene loaded, they'd go
    // under the World root, where `world.activeScene` scans the root's children on every create:
    // the "at the World root" case below measures that.)
    bench(`create+destroy ${k} (1%) Agent+Target nodes per step N=${n}`, () => {
      const f = cur();
      const nodes = f.nodes;
      const scene = f.extra as GameObject;
      for (let i = 0; i < k; i++) GameObject.destroy(nodes[i]);
      nodes.splice(0, k);
      for (let i = 0; i < k; i++) {
        const g = GameObject.create("c", { parent: scene });
        g.addData(Agent, { speed: 5 });
        g.addData(Target, { x: 1 });
        nodes.push(g);
      }
      f.engine.step(DT);
    }, {
      ...OPTS,
      setup: fixture(`churnScene${n}`, () => {
        const scene = GameObject.create("Scene");
        return { nodes: makeAgents(n, scene), extra: scene };
      }),
    });
    bench(`create+destroy ${k} (1%) nodes at the World root (no scene) per step N=${n}`, () => {
      const f = cur();
      const nodes = f.nodes;
      for (let i = 0; i < k; i++) GameObject.destroy(nodes[i]);
      nodes.splice(0, k);
      for (let i = 0; i < k; i++) {
        const g = GameObject.create("c");
        g.addData(Agent, { speed: 5 });
        g.addData(Target, { x: 1 });
        nodes.push(g);
      }
      f.engine.step(DT);
    }, { ...OPTS, setup: fixture(`churn${n}`, () => ({ nodes: makeAgents(n) })) });
    bench(`add+remove Extra data on ${k} (1%) existing nodes per step N=${n}`, () => {
      const f = cur();
      const nodes = f.nodes;
      const st = f.extra as { i: number };
      const off = st.i;
      for (let i = 0; i < k; i++) nodes[(off + i) % n].addData(Extra, { v: i });
      f.engine.step(DT);
      for (let i = 0; i < k; i++) nodes[(off + i) % n].removeData(Extra);
      st.i = (off + k) % n;
    }, { ...OPTS, setup: fixture(`addrem${n}`, () => ({ nodes: makeAgents(n), extra: { i: 0 } })) });
  });

  describe(`f. sparse query (10% match), N=${n}`, () => {
    bench(`query [Sparse]: 10% of N=${n} have it, 90% have Other`, () => { cur().engine.step(DT); }, {
      ...OPTS,
      setup: fixture(`sparse${n}`, () => {
        on.sparse = true;
        const nodes: GameObject[] = [];
        for (let i = 0; i < n; i++) {
          const g = GameObject.create("s");
          if (i % 10 === 0) g.addData(Sparse, { v: 1 }); else g.addData(Other, { v: 1 });
          nodes.push(g);
        }
        return { nodes };
      }),
    });
  });
}

// Keep the checksum observable so the work above can't be eliminated.
describe("checksum", () => {
  bench("noop (checksum sink)", () => { if (checksum === 0.123456) console.log(checksum); }, { time: 50, iterations: 1, warmupIterations: 0, warmupTime: 0 });
});
