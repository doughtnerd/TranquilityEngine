// Particle benchmark (ADR 0094, 0251): frame time against particle count for each backend, through the
// effect player the World's particle adapter plays each ParticleSystem with, on the Babylon engine. Query: ?engine=webgpu|webgl2,
// ?backend=cpu|gpu|js, ?counts=1000,10000, ?frames=120, ?shot=1 (stop after one run, for a
// screenshot). Results in `window.__bench` (see bench/particles/README.md).
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine.js";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder.js";
import { Scene } from "@babylonjs/core/scene.js";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture.js";
import { EffectPlayer, EffectResources } from "../../src/engine/render/babylon/effectPlayer";
import type { KernelExecutor } from "../../src/engine/scene/particleKernel";
import { formatParticleGraph } from "../../src/engine/scene/particleGraphFormat";
import { benchGraph } from "./graphs";

const q = new URLSearchParams(location.search);
const engineKind = q.get("engine") ?? "webgpu";
const backend = q.get("backend") ?? "gpu";
const counts = (q.get("counts") ?? "1000,10000,100000").split(",").map(Number);
const frames = Number(q.get("frames") ?? 120);

interface Row {
  engine: string;
  backend: string;
  executor: string;
  particles: number;
  alive: number;
  msPerFrame: number;
  errors: string[];
}

const errors: string[] = [];
const origError = console.error;
console.error = (...a: unknown[]) => {
  errors.push(a.map(String).join(" ").slice(0, 500));
  origError(...a);
};

async function makeEngine(canvas: HTMLCanvasElement): Promise<Engine | WebGPUEngine> {
  if (engineKind === "webgpu") {
    const e = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: false });
    await e.initAsync();
    return e;
  }
  return new Engine(canvas, false, { adaptToDeviceRatio: false });
}

async function sync(engine: Engine | WebGPUEngine): Promise<void> {
  if (engine.isWebGPU) {
    const device = (engine as unknown as { _device: { queue: { onSubmittedWorkDone(): Promise<void> } } })._device;
    await device.queue.onSubmittedWorkDone();
  } else {
    const gl = (engine as unknown as { _gl: WebGL2RenderingContext })._gl;
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }
}

/**
 * ADR 0126's looks, from the query: `&trail=N` adds a trail output of N points, `&blend=alpha` draws
 * alpha-blended (sorted by default), `&soft=M` makes the output soft over M metres.
 */
function looks(g: ReturnType<typeof benchGraph>): ReturnType<typeof benchGraph> {
  const sys = g.systems[0];
  const blend = q.get("blend");
  if (blend === "alpha" || blend === "premultiplied" || blend === "additive") sys.output.settings.blending = blend;
  if (q.get("soft")) sys.output.settings.softness = Number(q.get("soft"));
  if (q.get("material")) sys.output.settings.material = "materials/bench.material.json";
  if (q.get("trail")) sys.extraOutputs = [{ type: "trail", settings: { ...sys.output.settings, trailLength: Number(q.get("trail")) }, blocks: [] }];
  return g;
}

const benchMaterials = new WeakMap<Scene, PBRMaterial>();
function benchMaterial(scene: Scene): PBRMaterial | null {
  if (!q.get("material")) return null;
  let m = benchMaterials.get(scene);
  if (!m) {
    new HemisphericLight("light", new Vector3(0.3, 1, 0.2), scene);
    m = new PBRMaterial("bench material", scene);
    m.metallic = 0;
    m.roughness = 0.6;
    m.albedoColor.set(1, 1, 1);
    m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    benchMaterials.set(scene, m);
  }
  return m;
}

async function runOne(engine: Engine | WebGPUEngine, count: number): Promise<Row> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.07, 0.07, 0.09, 1);
  const camera = new ArcRotateCamera("cam", Math.PI / 2, Math.PI / 2.6, 9, new Vector3(0, 2, 0), scene);
  scene.activeCamera = camera;
  CreateGround("ground", { width: 8, height: 8 }, scene);
  const executors: KernelExecutor[] | undefined = backend === "js" ? ["js"] : undefined;
  const resources = new EffectResources({
    scene,
    texture: () => Promise.reject(new Error("no textures")),
    kernelExecutors: executors,
    // `&material=1`: the output draws with a PBR material asset (ADR 0126), lit by a hemispheric light.
    material: () => benchMaterial(scene),
  });
  // The effect as its asset file reads (`backend=cpu` picks the "cpu" Simulation setting: the JavaScript executor since ADR 0251).
  const raw: unknown = JSON.parse(formatParticleGraph(looks(benchGraph(count, backend === "cpu" ? "cpu" : "gpu"))));
  const compiled = resources.compile(raw, "bench");
  if (!compiled) throw new Error(`the bench effect didn't compile: ${errors.join("; ")}`);
  const player = new EffectPlayer(resources, compiled.program, { name: "Bench", seed: 1 });
  const dt = 1 / 60;
  const frame = () => {
    if (!player.built) player.build();
    player.step(dt);
  };
  // Warm up: fill the system (lifetime 2 s) and compile the pipelines.
  for (let i = 0; i < 150; i++) {
    frame();
    if (q.get("nodraw")) for (const d of player.draws) for (const m of d.meshes) m.isVisible = false; // simulation only
    scene.render();
    if (i % 30 === 0) await sync(engine);
  }
  await sync(engine);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    frame();
    scene.render();
    if (i % 10 === 9) await sync(engine); // keep the GPU from queueing far ahead
  }
  await sync(engine);
  const ms = (performance.now() - t0) / frames;
  const row: Row = { engine: engineKind, backend, executor: resources.plan(compiled.program).executors[0] ?? "?", particles: count, alive: player.count, msPerFrame: Math.round(ms * 100) / 100, errors: errors.splice(0) };
  if (q.get("shot")) {
    // Each kernel draw's shader state, for checking new draw variants compile (ADR 0126).
    Object.assign(window, { __player: player, __scene: scene });
    (window as unknown as { __draws: unknown }).__draws = player.draws.map((d) => ({ name: d.name, ready: d.isReady(), error: d.meshes[0]?.material?.getEffect()?.getCompilationError() ?? null }));
    // Render into a texture and read it back (WebGPU canvases don't always reach headless screenshots).
    const rtt = new RenderTargetTexture("shot", { width: 640, height: 360 }, scene, false);
    camera.outputRenderTarget = rtt;
    frame();
    scene.render();
    await sync(engine);
    const px = (await rtt.readPixels())! as Uint8Array;
    const shot = document.createElement("canvas");
    shot.width = 640;
    shot.height = 360;
    const ctx = shot.getContext("2d")!;
    const img = ctx.createImageData(640, 360);
    for (let y = 0; y < 360; y++)
      for (let x = 0; x < 640; x++) {
        const src = ((engine.isWebGPU ? y : 359 - y) * 640 + x) * 4;
        const d = (y * 640 + x) * 4;
        img.data[d] = px[src];
        img.data[d + 1] = px[src + 1];
        img.data[d + 2] = px[src + 2];
        img.data[d + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    shot.id = "shot";
    document.body.insertBefore(shot, document.body.firstChild);
  } else {
    player.dispose();
    resources.dispose();
    scene.dispose();
  }
  return row;
}

async function main(): Promise<Row[]> {
  const canvas = document.getElementById("c") as HTMLCanvasElement;
  const engine = await makeEngine(canvas);
  const rows: Row[] = [];
  for (const n of counts) {
    rows.push(await runOne(engine, n));
    document.getElementById("out")!.textContent = JSON.stringify(rows, null, 1);
    if (q.get("shot")) break;
  }
  return rows;
}

main().then(
  (r) => ((window as unknown as { __bench: unknown }).__bench = r),
  (err: Error) => ((window as unknown as { __bench: unknown }).__bench = { error: String(err.stack ?? err), errors }),
);
