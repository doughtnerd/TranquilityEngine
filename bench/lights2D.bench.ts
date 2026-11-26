/**
 * The 2D lighting rig's CPU cost per frame (ADR 0399, 0413), headless on Babylon's NullEngine.
 * Run: `npx vitest bench --run bench/lights2D.bench.ts`.
 *
 * The scene is ADR 0399's budget scene: 1 global and 12 point lights, 4 of them shadowed, 200 caster edges (50 square
 * casters), one layer batch, two blend styles. Timed: `BabylonLights2D.sync` (batching, ranking, building every light's
 * and shadow's vertex data and uploading it), the rig's whole per-frame CPU work. Budget at the Android floor: 0.5 ms
 * (ADR 0399); this measures the development machine, so the floor is about 4–6× this.
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { afterAll, test } from "vitest";
import { LIGHTS_2D_QUALITY } from "../src/engine/core/graphics";
import { World } from "../src/engine/core/World";
import { Assets, Engine, GameObject, Light2D, SceneManager, ShadowCaster2D, Vector2 } from "../src/myco";
import { BabylonLights2D } from "../src/engine/render/babylon/lights2D";

const results: { name: string; ops: number; meanMs: number; p99Ms: number }[] = [];

afterAll(() => {
  console.log("\n| scenario | ops/s | mean ms | p99 ms |\n|---|---|---|---|");
  for (const r of results) console.log(`| ${r.name} | ${r.ops.toFixed(1)} | ${r.meanMs.toFixed(3)} | ${r.p99Ms.toFixed(3)} |`);
});

test("2D lighting sync: 13 lights, 4 shadowed, 200 caster edges (low tier)", async ({ bench }) => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  const app = await Engine.create({ headless: true, project: { lighting2D: { blendStyles: [{ name: "Multiply", mask: "none", multiply: 1, add: 0 }, { name: "Glow", mask: "none", multiply: 0, add: 1 }] } } });
  await SceneManager.load("s.json");
  const world = World.require();
  GameObject.create("global").addBehavior(Light2D, { type: "global", intensity: 0.2 });
  const lights: Light2D[] = [];
  for (let i = 0; i < 12; i++) {
    const n = GameObject.create(`light${i}`);
    n.transform!.position.set((i % 4) * 5 - 7.5, Math.floor(i / 4) * 5 - 5, 0);
    lights.push(n.addBehavior(Light2D, { type: "point", outerRadius: 6, blendStyle: i % 3 === 0 ? "Glow" : "Multiply", shadows: i < 4 }));
  }
  for (let i = 0; i < 50; i++) {
    const n = GameObject.create(`caster${i}`);
    n.transform!.position.set((i % 10) * 2 - 9, Math.floor(i / 10) * 2 - 5, 0);
    n.addBehavior(ShadowCaster2D, { shape: "custom", path: [new Vector2(-0.4, -0.4), new Vector2(0.4, -0.4), new Vector2(0.4, 0.4), new Vector2(-0.4, 0.4)] });
  }
  const engine = new NullEngine();
  const rig = new BabylonLights2D({ scene: new Scene(engine), texture: () => null, textureSize: () => null });
  let tick = 0;
  const frame = () => {
    tick++;
    lights[tick % 12]!.node.transform!.position.x += 0.01; // lights move: no rebuild, just new vertex data
    rig.sync(world, LIGHTS_2D_QUALITY.low);
  };
  frame();
  const r = await bench("sync", frame).run({ time: 1000, warmupTime: 200, iterations: 20, warmupIterations: 5 });
  results.push({ name: "13 lights, 4 shadowed, 200 edges", ops: r.throughput.mean, meanMs: r.latency.mean, p99Ms: r.latency.p99 });
  console.log("state", JSON.stringify(rig.state()));
  rig.dispose();
  engine.dispose();
  app.dispose();
}, 120_000);
