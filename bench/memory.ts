// Approximate heap growth per entity for the "agent steering" scenario (Agent 7 f32 + Target 3 f32
// data components on a plain node). Run with `npm run bench:memory`; needs --expose-gc (the npm
// script passes it) or the numbers include uncollected garbage. Typed-array storage lives outside
// the JS heap, so arrayBuffers is reported separately from heapUsed.
import { Engine, GameObject, defineComponent, f32 } from "../src/engine/index.ts";

const Agent = defineComponent("bench.Agent", { x: f32, y: f32, z: f32, vx: f32, vy: f32, vz: f32, speed: f32 });
const Target = defineComponent("bench.Target", { x: f32, y: f32, z: f32 });

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) console.warn("global.gc unavailable: run with --expose-gc for stable numbers.");
const settle = () => { gc?.(); gc?.(); return process.memoryUsage(); };

for (const n of [1000, 10000, 50000]) {
  const engine = await Engine.create({ headless: true });
  engine.step(1 / 60);
  const before = settle();
  const nodes: GameObject[] = [];
  for (let i = 0; i < n; i++) {
    const g = GameObject.create("a");
    g.addData(Agent, { x: i, speed: 5 });
    g.addData(Target, { x: 1 });
    nodes.push(g);
  }
  engine.step(1 / 60);
  const after = settle();
  const heap = (after.heapUsed - before.heapUsed) / n;
  const ab = (after.arrayBuffers - before.arrayBuffers) / n;
  console.log(`N=${n}: heapUsed ${heap.toFixed(0)} B/entity, arrayBuffers ${ab.toFixed(0)} B/entity, total ${(heap + ab).toFixed(0)} B/entity (${nodes.length} nodes)`);
  engine.dispose();
}
