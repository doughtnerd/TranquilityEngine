// Runs the same kernels on the JavaScript, WebGPU and WebGL2 executors with the same uniforms and
// compares their particle state (ADR 0094). Opened by `npm run bench:particles` (run.mjs); results in
// `window.__parity`.
import { compileParticleGraph } from "../../src/engine/scene/particleCompile";
import { compileParticleKernels, KERNEL_FLOATS, type KernelSystem } from "../../src/engine/scene/particleKernel";
import { KernelEffect, JsRun, type KernelRun } from "../../src/engine/render/particles/gpu/kernelEffect";
import { WebGpuRun, type GpuDevice } from "../../src/engine/render/particles/gpu/webgpuRun";
import { WebGl2Run, supportsTextureKernels } from "../../src/engine/render/particles/gpu/webgl2Run";
import { parityGraph } from "./graphs";

interface Result {
  backend: string;
  system: string;
  available: boolean;
  errors: string[];
  alive: [number, number];
  maxError: number;
  mismatched: number;
}

class TeeRun implements KernelRun {
  readonly kind = "js" as const;
  constructor(readonly runs: KernelRun[]) {}
  step(u: Float32Array, lut: Float32Array | null, parent: KernelRun | null): void {
    this.runs.forEach((r, i) => r.step(u, lut, parent instanceof TeeRun ? parent.runs[i] : null));
  }
  clear(): void {
    for (const r of this.runs) r.clear();
  }
  dispose(): void {
    for (const r of this.runs) r.dispose();
  }
}

function compare(a: Float32Array, b: Float32Array, k: KernelSystem): { alive: [number, number]; maxError: number; mismatched: number } {
  let maxError = 0;
  let mismatched = 0;
  let aliveA = 0;
  let aliveB = 0;
  for (let i = 0; i < k.capacity; i++) {
    const o = i * KERNEL_FLOATS;
    const la = a[o + 7] > 0;
    const lb = b[o + 7] > 0;
    if (la) aliveA++;
    if (lb) aliveB++;
    if (la !== lb) {
      mismatched++;
      continue;
    }
    if (!la) continue;
    for (let c = 0; c < KERNEL_FLOATS; c++) {
      const e = Math.abs(a[o + c] - b[o + c]) / Math.max(1, Math.abs(a[o + c]));
      if (e > 1e-3) mismatched += 0; // counted by maxError
      maxError = Math.max(maxError, e);
    }
  }
  return { alive: [aliveA, aliveB], maxError, mismatched };
}

async function run(): Promise<Result[]> {
  const g = parityGraph(2048);
  const program = compileParticleGraph(g);
  const kp = compileParticleKernels(g, program);
  const out: Result[] = [];

  let device: GpuDevice | null = null;
  const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<{ requestDevice(): Promise<GpuDevice> } | null> } };
  if (nav.gpu) {
    const adapter = await nav.gpu.requestAdapter();
    device = adapter ? await adapter.requestDevice() : null;
  }
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  const glOk = !!gl && supportsTextureKernels(gl);

  const runs = new Map<KernelSystem, { js: JsRun; gpu: WebGpuRun | null; gl: WebGl2Run | null }>();
  const host = {
    executors: ["js" as const],
    createRun(k: KernelSystem): KernelRun {
      const js = new JsRun(k);
      const gpu = device ? new WebGpuRun(device, k) : null;
      const glr = glOk ? new WebGl2Run(gl!, k) : null;
      runs.set(k, { js, gpu, gl: glr });
      return new TeeRun([js, ...(gpu ? [gpu] : []), ...(glr ? [glr] : [])]);
    },
  };
  const fx = new KernelEffect(kp.systems, program.effect.emitters, host, { seed: 1234 });
  const world = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 1, -0.25, 1];
  for (let f = 0; f < 90; f++) fx.step(1 / 60, world, 1, [1, 1, 1, 1], { time: f / 60, deltaTime: 1 / 60, playTime: f / 60, properties: new Map(), random: Math.random }, null);

  for (const [k, r] of runs) {
    const js = r.js.js.state;
    if (r.gpu) {
      const errors = await r.gpu.ready;
      const s = await r.gpu.read();
      out.push({ backend: "webgpu", system: k.name, available: true, errors, ...compare(js, s, k) });
    } else out.push({ backend: "webgpu", system: k.name, available: false, errors: [], alive: [0, 0], maxError: 0, mismatched: 0 });
    if (r.gl) {
      const s = r.gl.read();
      out.push({ backend: "webgl2", system: k.name, available: true, errors: r.gl.errors, ...compare(js, s, k) });
    } else out.push({ backend: "webgl2", system: k.name, available: false, errors: [], alive: [0, 0], maxError: 0, mismatched: 0 });
  }
  return out;
}

run().then(
  (r) => {
    (window as unknown as { __parity: unknown }).__parity = r;
    document.getElementById("out")!.textContent = JSON.stringify(r, null, 2);
  },
  (err: Error) => {
    (window as unknown as { __parity: unknown }).__parity = { error: String(err.stack ?? err) };
    document.getElementById("out")!.textContent = String(err.stack ?? err);
  },
);
