/**
 * GPU instancing and sprite batching benchmarks (ADR 0108), headless on Babylon's NullEngine.
 * Run: `npx vitest bench --run bench/instancing.bench.ts`.
 *
 * Timed: the per-frame CPU cost, `syncMeshes` (or the sprite sync + flush) and `renderer.render(world)`
 * (Babylon's culling, sorting and draw dispatch; NullEngine has no GPU). Baselines are `"instancing": "off"`
 * (one mesh per renderer) and the editor's per-sprite-mesh path (fill = true).
 * Draw calls are counted deterministically in `beforeAll` and printed once; see bench/instancing.browser.md for GPU time.
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Camera as BabylonCamera } from "@babylonjs/core/Cameras/camera.js";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { afterAll, beforeAll, describe, test } from "vitest";
import { World } from "../src/engine/core/World";
import { Assets, Engine, GameObject, Material, MeshRenderer, SceneManager, SpriteRenderer, Vector2 } from "../src/engine/index";
import { BabylonRenderer } from "../src/engine/render/babylon/BabylonRenderer";
import type { MeshBatches } from "../src/engine/render/babylon/meshBatches";
import type { SpriteBatcher } from "../src/engine/render/babylon/spriteBatches";

const SIZES = [1000, 4000];
const MESH_MODES = ["auto", "thin", "off"] as const;
const SPRITE_MODES = ["batched", "per-mesh"] as const;
const results: { name: string; ops: number; meanMs: number; p99Ms: number }[] = [];
interface Opts { time: number; warmupTime: number; iterations: number; warmupIterations: number; setup: () => Promise<void> }

/** Vitest 5's benchmark API (as bench/ecs.bench.ts): `bench` comes from the test context; setup runs untimed. */
function bench(name: string, fn: () => void, opts: Opts): void {
  test(name, async ({ bench: b }) => {
    await opts.setup();
    const r = await b(name, fn).run({ time: opts.time, warmupTime: opts.warmupTime, iterations: opts.iterations, warmupIterations: opts.warmupIterations });
    results.push({ name, ops: r.throughput.mean, meanMs: r.latency.mean, p99Ms: r.latency.p99 });
  }, 120_000);
}

afterAll(() => {
  console.log("\n| scenario | ops/s | mean ms | p99 ms |\n|---|---|---|---|");
  for (const r of results) console.log(`| ${r.name} | ${r.ops.toFixed(1)} | ${r.meanMs.toFixed(3)} | ${r.p99Ms.toFixed(3)} |`);
});

const OPTS = { time: 400, warmupTime: 100, iterations: 5, warmupIterations: 2 };

type Internals = {
  scene: Scene;
  batches: MeshBatches;
  spriteBatcher: SpriteBatcher;
  syncSprite(w: World, s: SpriteRenderer, snap: number): void;
  flushSprites(): void;
  spriteSnap(w: World): number;
};

interface Fixture {
  syncOnly(): void;
  frame(): void;
  move(): void;
  drawCalls(): { engineCalls: number; drawCalls: number; batches: number; activeMeshes: number; instances: number };
  dispose(): void;
}

async function build(kind: "mesh" | "sprite", mode: string, n: number): Promise<Fixture> {
  Assets.clearSources();
  Assets.addSource(
    Assets.fromObject({
      "s.json": { format: "myco.scene@1", nodes: [] },
      "m/auto.material.json": { format: "myco.material@1", color: "#ff0000" },
      "m/thin.material.json": { format: "myco.material@1", color: "#ff0000", instancing: "thin" },
      "m/off.material.json": { format: "myco.material@1", color: "#ff0000", instancing: "off" },
    }),
  );
  await Engine.create({ headless: true });
  await SceneManager.load("s.json");
  const world = World.require();
  const engine = new NullEngine();
  const Ctor = BabylonRenderer as unknown as new (e: NullEngine, s: unknown, fill: boolean) => BabylonRenderer;
  const fill = kind === "sprite" && mode === "per-mesh";
  const renderer = new Ctor(engine, world.settings, fill);
  const internals = renderer as unknown as Internals;

  const side = Math.ceil(Math.sqrt(n));
  const nodes: GameObject[] = [];
  for (let i = 0; i < n; i++) {
    const node = GameObject.create(`n${i}`);
    node.transform!.position.set(((i % side) - side / 2) * 1.5, (Math.floor(i / side) - side / 2) * 1.5, -20);
    if (kind === "mesh") node.addBehavior(MeshRenderer, { mesh: "builtin:cube", material: `asset:m/${mode === "auto" ? "auto" : mode}.material.json` });
    else node.addBehavior(SpriteRenderer, { size: new Vector2(1, 1) });
    nodes.push(node);
  }
  const syncOnly = () => {
    if (kind === "mesh") renderer.syncMeshes(world);
    else {
      const snap = internals.spriteSnap(world);
      for (const s of world._componentsOfType(SpriteRenderer)) internals.syncSprite(world, s, snap);
      internals.flushSprites();
    }
  };
  let tick = 0;
  const move = () => {
    tick++;
    for (let i = tick % 10; i < n; i += 10) nodes[i].transform!.position.x += 0.01; // 10% of the nodes
  };
  syncOnly();
  // A camera for scene.render() (the full renderer.sync/render needs lighting textures NullEngine can't create).
  const camera = new FreeCamera("bench", new Vector3(0, 0, 0), internals.scene);
  camera.setTarget(new Vector3(0, 0, -1));
  camera.mode = BabylonCamera.ORTHOGRAPHIC_CAMERA; // everything in view, so culling doesn't hide the difference
  const half = side * 0.9;
  camera.orthoLeft = -half; camera.orthoRight = half; camera.orthoTop = half; camera.orthoBottom = -half;
  internals.scene.activeCamera = camera;
  return {
    syncOnly,
    frame() {
      internals.scene.render();
    },
    move,
    drawCalls() {
      const scene = internals.scene;
      scene.render();
      const calls = (engine as unknown as { _drawCalls?: { current: number; fetchNewFrame(): void } })._drawCalls;
      calls?.fetchNewFrame();
      // NullEngine never counts engine._drawCalls (always 0), so derive them: a draw is one source mesh per frame,
      // however many instances or thin instances it carries (an InstancedMesh draws through its source).
      const draws = new Set<unknown>();
      let instances = 0;
      for (const m of scene.getActiveMeshes().data.slice(0, scene.getActiveMeshes().length)) {
        draws.add(m instanceof InstancedMesh ? m.sourceMesh : m);
        instances += m.thinInstanceCount > 0 ? m.thinInstanceCount : 1;
      }
      const batches = kind === "mesh" ? internals.batches.stats().batches : internals.spriteBatcher.stats().batches;
      return { engineCalls: calls?.current ?? -1, drawCalls: draws.size, batches, activeMeshes: scene.getActiveMeshes().length, instances };
    },
    dispose() {
      Material._resetShared();
      renderer.dispose();
      engine.dispose();
    },
  };
}

beforeAll(async () => {
  const rows: Record<string, unknown>[] = [];
  for (const kind of ["mesh", "sprite"] as const) {
    for (const n of SIZES) {
      for (const mode of kind === "mesh" ? MESH_MODES : SPRITE_MODES) {
        const f = await build(kind, mode, n);
        const d = f.drawCalls();
        rows.push({ scene: kind, mode, N: n, "draw calls (derived)": d.drawCalls, "objects drawn": d.instances, "batches (stats)": d.batches, "active meshes": d.activeMeshes, "engine._drawCalls": d.engineCalls });
        f.dispose();
      }
    }
  }
  console.table(rows);
});

for (const kind of ["mesh", "sprite"] as const) {
  for (const n of SIZES) {
    describe(`${kind}s N=${n}`, () => {
      for (const mode of kind === "mesh" ? MESH_MODES : SPRITE_MODES) {
        let f: Fixture;
        const setup = async () => {
          f?.dispose();
          f = await build(kind, mode, n);
        };
        const opts = (): Opts => ({ ...OPTS, setup });
        bench(`${kind}s N=${n} sync static [${mode}]`, () => f.syncOnly(), opts());
        bench(`${kind}s N=${n} sync 10% moving [${mode}]`, () => { f.move(); f.syncOnly(); }, opts());
        bench(`${kind}s N=${n} frame static [${mode}]`, () => { f.syncOnly(); f.frame(); }, opts());
        bench(`${kind}s N=${n} frame 10% moving [${mode}]`, () => { f.move(); f.syncOnly(); f.frame(); }, opts());
        afterAll(() => f?.dispose());
      }
    });
  }
}
