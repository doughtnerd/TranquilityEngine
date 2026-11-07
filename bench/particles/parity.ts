// Runs the same kernels on the JavaScript, WebGPU and WebGL2 executors with the same uniforms and
// compares their particle state (ADR 0094). Opened by `npm run bench:particles` (run.mjs); results in
// `window.__parity`.
import { compileParticleGraph } from "../../src/engine/scene/particleCompile";
import { compileParticleKernels, KERNEL_FLOATS, type KernelSystem } from "../../src/engine/scene/particleKernel";
import { KernelEffect, JsRun, type KernelRun } from "../../src/engine/render/particles/gpu/kernelEffect";
import { WebGpuRun, type GpuDevice } from "../../src/engine/render/particles/gpu/webgpuRun";
import { WebGl2Run, supportsTextureKernels } from "../../src/engine/render/particles/gpu/webgl2Run";
import { parityGraph } from "./graphs";
import { BUFFER } from "../../src/engine/render/particles/gpu/webgpuRun";
import { WebGl2Sorter, WebGpuSorter, sortLayout, sortPairsJs } from "../../src/engine/render/particles/gpu/sort";

/** Sort parity (ADR 0126): the GPU sorts must give the same key order as the JavaScript sort. */
async function sortParity(k: KernelSystem, js: Float32Array, gpu: WebGpuRun | null, glr: WebGl2Run | null, device: GpuDevice | null, gl: WebGL2RenderingContext | null): Promise<Result[]> {
  const row = [0.3, -0.2, 0.9, 1.5];
  const layout = sortLayout(k.capacity);
  const ref = new Float32Array(layout.n * 2);
  sortPairsJs(js, k.capacity, row, ref, layout);
  const check = (pairs: Float32Array, backend: string): Result => {
    let mismatched = 0;
    let maxError = 0;
    let alive = 0;
    for (let i = 0; i < layout.n; i++) {
      const a = ref[i * 2];
      if (a < 1e38) alive++;
      const e = Math.abs(a - pairs[i * 2]) / Math.max(1, Math.abs(a));
      if (e > 1e-3) mismatched++;
      maxError = Math.max(maxError, Math.min(e, 1));
    }
    return { backend, system: k.name, available: true, errors: [], alive: [alive, alive], maxError, mismatched };
  };
  const out: Result[] = [];
  if (gpu && device) {
    const sorter = new WebGpuSorter(device, k.capacity);
    sorter.sort(gpu.current(), row);
    const staging = device.createBuffer({ size: layout.n * 8, usage: BUFFER.MAP_READ | BUFFER.COPY_DST });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(sorter.pairs, 0, staging, 0, layout.n * 8);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync!(1);
    out.push(check(new Float32Array(staging.getMappedRange!().slice(0)), "webgpu sort"));
    staging.unmap!();
  }
  if (glr && gl) {
    const sorter = new WebGl2Sorter(gl, k.capacity);
    const cur = glr.current();
    sorter.sort(cur[0], cur[1], glr.width, row);
    const r = check(sorter.read(), "webgl2 sort");
    r.errors = sorter.errors;
    out.push(r);
  }
  return out;
}

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

/**
 * Dead-list runs (ADR 0126) put particles in different slots (WebGPU pops free slots in whatever order its
 * invocations run), so particles are matched by their seed instead of their slot.
 */
function compareBySeed(a: Float32Array, b: Float32Array, k: KernelSystem): { alive: [number, number]; maxError: number; mismatched: number } {
  const bySeed = (s: Float32Array) => {
    const m = new Map<number, number>();
    for (let i = 0; i < k.capacity; i++) if (s[i * KERNEL_FLOATS + 7] > 0) m.set(s[i * KERNEL_FLOATS + 15], i);
    return m;
  };
  const ma = bySeed(a);
  const mb = bySeed(b);
  let maxError = 0;
  let mismatched = 0;
  for (const [seed, i] of ma) {
    const j = mb.get(seed);
    if (j === undefined) {
      mismatched++;
      continue;
    }
    for (let c = 0; c < KERNEL_FLOATS; c++) {
      const x = a[i * KERNEL_FLOATS + c];
      maxError = Math.max(maxError, Math.abs(x - b[j * KERNEL_FLOATS + c]) / Math.max(1, Math.abs(x)));
    }
  }
  for (const seed of mb.keys()) if (!ma.has(seed)) mismatched++;
  return { alive: [ma.size, mb.size], maxError, mismatched };
}

/**
 * A GPU-event child keeps the slot mapping (its slots belong to its parent's slots), and with a dead list
 * the parent's slots differ between executors, so the child's seeds do too: only its count is compared.
 */
function childCounts(r: ReturnType<typeof compareBySeed>, k: KernelSystem): ReturnType<typeof compareBySeed> {
  return k.event ? { ...r, mismatched: 0, maxError: 0 } : r;
}

async function run(): Promise<Result[]> {
  return [...(await runMode(false)), ...(await runMode(true))];
}

/** One parity run: 0094's ring on every executor, or the dead list on JavaScript and WebGPU (WebGL2 has none). */
async function runMode(deadList: boolean): Promise<Result[]> {
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
      const js = new JsRun(k, { deadList });
      const gpu = device ? new WebGpuRun(device, k, undefined, null, { deadList }) : null;
      const glr = glOk && !deadList ? new WebGl2Run(gl!, k) : null;
      runs.set(k, { js, gpu, gl: glr });
      return new TeeRun([js, ...(gpu ? [gpu] : []), ...(glr ? [glr] : [])]);
    },
  };
  const fx = new KernelEffect(kp.systems, program.effect.emitters, host, { seed: 1234 });
  const world = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 1, -0.25, 1];
  const frame = (f: number) => fx.step(1 / 60, world, 1, [1, 1, 1, 1], { time: f / 60, deltaTime: 1 / 60, playTime: f / 60, properties: new Map(), random: Math.random }, null);
  for (let f = 0; f < 90; f++) frame(f);
  if (deadList) {
    // Frames a game's pace apart, so the dead list's count read-backs land (the loop above outruns them).
    for (let f = 90; f < 93; f++) {
      await device?.queue.onSubmittedWorkDone?.();
      await new Promise((res) => setTimeout(res, 50));
      frame(f);
    }
    await device?.queue.onSubmittedWorkDone?.();
  }

  for (const [k, r] of runs) {
    const js = r.js.js.state;
    if (r.gpu) {
      const errors = await r.gpu.ready;
      const s = await r.gpu.read();
      if (deadList && !k.event) {
        // The dead list's alive counter, read back without waiting (a frame or two late): let it land.
        await new Promise((res) => setTimeout(res, 100));
        out.push({ backend: "webgpu (count)", system: k.name, available: true, errors: [], alive: [r.js.alive, r.gpu.alive ?? -1], maxError: 0, mismatched: 0 });
      }
      out.push({ backend: deadList ? "webgpu (dead list)" : "webgpu", system: k.name, available: true, errors, ...(deadList ? childCounts(compareBySeed(js, s, k), k) : compare(js, s, k)) });
    } else out.push({ backend: "webgpu", system: k.name, available: false, errors: [], alive: [0, 0], maxError: 0, mismatched: 0 });
    if (deadList) continue;
    out.push(...(await sortParity(k, js, r.gpu, r.gl, device, gl)));
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
