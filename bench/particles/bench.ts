// Particle benchmark (ADR 0094): frame time against particle count for each backend, through the
// real World particle player on the Babylon engine. Query: ?engine=webgpu|webgl2,
// ?backend=cpu|gpu|js, ?counts=1000,10000, ?frames=120, ?shot=1 (stop after one run, for a
// screenshot). Results in `window.__bench` (see bench/particles/README.md).
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine.js";
import { Color4 } from "@babylonjs/core/Maths/math.color.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder.js";
import { Scene } from "@babylonjs/core/scene.js";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture.js";
import { Color as EngineColor } from "../../src/engine/core/math";
import { BabylonParticles } from "../../src/engine/render/babylon/particles";
import type { ParticleCommand, ParticleSystem } from "../../src/engine/render/components";
import type { KernelExecutor } from "../../src/engine/scene/particleKernel";
import { particleGraphJSON } from "../../src/engine/scene/particleGraphFormat";
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
  if (q.get("trail")) sys.extraOutputs = [{ type: "trail", settings: { ...sys.output.settings, trailLength: Number(q.get("trail")) }, blocks: [] }];
  return g;
}

async function runOne(engine: Engine | WebGPUEngine, count: number): Promise<Row> {
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0.07, 0.07, 0.09, 1);
  const camera = new ArcRotateCamera("cam", Math.PI / 2, Math.PI / 2.6, 9, new Vector3(0, 2, 0), scene);
  scene.activeCamera = camera;
  CreateGround("ground", { width: 8, height: 8 }, scene);
  const executors: KernelExecutor[] | undefined = backend === "js" ? ["js"] : undefined;
  const player = new BabylonParticles({
    scene,
    editor: false,
    worldMatrix: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    selected: () => true,
    texture: () => Promise.reject(new Error("no textures")),
    tierScale: () => 1,
    kernelExecutors: executors,
  });
  const c = {
    isActiveAndEnabled: true,
    effect: "",
    embeddedEffect: particleGraphJSON(looks(benchGraph(count, backend === "cpu" ? "cpu" : "gpu"))),
    overrides: {},
    playOnAwake: true,
    timeScale: 1,
    tint: EngineColor.white,
    emissionScale: 1,
    destroyOnFinish: false,
    seed: 1,
    _commands: [] as ParticleCommand[],
    _state: { playing: false, paused: false, time: 0, count: 0, alive: false },
    node: { name: "Bench" },
  } as unknown as ParticleSystem;
  const dt = 1 / 60;
  // Warm up: fill the system (lifetime 2 s) and compile the pipelines.
  for (let i = 0; i < 150; i++) {
    player.sync([c], dt, dt);
    if (q.get("nodraw")) for (const d of player.kernelDrawsOf(c)) d.mesh.isVisible = false; // simulation only
    scene.render();
    if (i % 30 === 0) await sync(engine);
  }
  await sync(engine);
  if (q.get("nosim")) (player as unknown as { kernelEffectOf(c: ParticleSystem): { step(): void } | null }).kernelEffectOf(c)!.step = () => {};
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    player.sync([c], dt, dt);
    scene.render();
    if (i % 10 === 9) await sync(engine); // keep the GPU from queueing far ahead
  }
  await sync(engine);
  const ms = (performance.now() - t0) / frames;
  const row: Row = { engine: engineKind, backend, executor: player.backendsOf(c)[0] ?? "?", particles: count, alive: c._state.count, msPerFrame: Math.round(ms * 100) / 100, errors: errors.splice(0) };
  if (q.get("shot")) {
    // Each kernel draw's shader state, for checking new draw variants compile (ADR 0126).
    (window as unknown as { __draws: unknown }).__draws = player.kernelDrawsOf(c).map((d) => ({ name: d.mesh.name, ready: d.mesh.isReady(true), error: d.material.getEffect()?.getCompilationError() ?? null }));
    // Render into a texture and read it back (WebGPU canvases don't always reach headless screenshots).
    const rtt = new RenderTargetTexture("shot", { width: 640, height: 360 }, scene, false);
    camera.outputRenderTarget = rtt;
    player.sync([c], dt, dt);
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
