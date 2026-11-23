// Internal (ADR 0094, 0370): particles on the GPU kernel executor's WebGPU backend (`render/gpuKernels`).
// Runs a kernel's WGSL (`wgslSimulation`) on a raw GPUDevice (the Babylon engine's, or any): state in
// two storage buffers swapped each frame, uniforms and the look-up table in two more, one dispatch per
// frame (two with a dead list). Renderer-neutral: the Babylon backend passes a buffer factory so its
// draws can bind the same buffers.
import { KERNEL_FLOATS, LUT_SAMPLES, U, type KernelSystem } from "../../../scene/particleKernel";
import { PingPong } from "../../gpuKernels/layout";
import { BUFFER, GpuKernel, GpuReadback, readBuffer, storageBufferFactory, type BufferFactory, type GpuBinding, type GpuBuffer, type GpuDevice, type GpuDispatch, type GpuResource } from "../../gpuKernels/webgpu";
import type { KernelRun } from "./kernelEffect";
import { WORKGROUP, wgslSimulation } from "./kernelShader";

const ZERO_I32 = new Int32Array(1);

/** Holder for the depth texture view a depth-colliding kernel samples. */
export interface DepthViewSource {
  view(): unknown | null;
}

/** The simulation's bindings (`wgslSimulation`'s group 0): which a kernel has depends on its features. */
function simulationBindings(kernel: KernelSystem, deadList: boolean): GpuBinding[] {
  const b: GpuBinding[] = [
    { binding: 0, kind: "read" }, // ku: uniforms
    { binding: 1, kind: "read" }, // state in
    { binding: 2, kind: "storage" }, // state out
    { binding: 3, kind: "read" }, // kl: look-up table
  ];
  if (kernel.event) b.push({ binding: 4, kind: "read" }); // the event parent's state
  if (kernel.depth) b.push({ binding: 5, kind: "texture" }); // the scene's depth
  if (deadList) b.push({ binding: 6, kind: "storage" }, { binding: 7, kind: "storage" }); // kdead, kcount
  if (kernel.trail) b.push({ binding: 8, kind: "storage" }); // trail history
  return b;
}

export class WebGpuRun implements KernelRun {
  readonly kind = "webgpu" as const;
  readonly uniforms: GpuBuffer;
  readonly lut: GpuBuffer;
  private readonly state: PingPong<GpuBuffer>;
  private readonly gpu: GpuKernel;
  private readonly zeros: Float32Array;
  private lastDepth: unknown = null;
  /** Dead list (ADR 0126): free slots and counters [free, alive], when the system keeps one. */
  private readonly dead: { list: GpuBuffer; count: GpuBuffer; read: GpuReadback } | null = null;
  /** Trail history (ADR 0126), when the kernel has trail outputs. */
  readonly history: GpuBuffer | null = null;
  /** The last alive count read back (a frame or two old), or null before the first read. */
  alive: number | null = null;
  /** Shader compile messages, if the device reported any (the parity tool). */
  readonly ready: Promise<string[]>;

  constructor(
    private readonly device: GpuDevice,
    readonly kernel: KernelSystem,
    factory: BufferFactory = storageBufferFactory(device),
    private readonly depth: DepthViewSource | null = null,
    opts: { deadList?: boolean } = {},
  ) {
    const deadList = !!opts.deadList && !kernel.event;
    const bytes = kernel.capacity * KERNEL_FLOATS * 4;
    this.state = new PingPong([factory(bytes, `particles ${kernel.name} state 0`), factory(bytes, `particles ${kernel.name} state 1`)]);
    this.uniforms = factory(kernel.uniformVec4 * 16, `particles ${kernel.name} uniforms`);
    this.lut = factory(Math.max(1, kernel.luts.length) * LUT_SAMPLES * 16, `particles ${kernel.name} lut`);
    this.zeros = new Float32Array(kernel.capacity * KERNEL_FLOATS);
    // An explicit layout: "auto" would drop bindings a kernel doesn't read (a system without curves never reads kl).
    this.gpu = new GpuKernel(device, {
      label: `particles ${kernel.name}`,
      code: wgslSimulation(kernel, { deadList }),
      entryPoints: deadList ? ["main", "spawn"] : ["main"],
      bindings: simulationBindings(kernel, deadList),
      workgroup: WORKGROUP,
    });
    this.ready = this.gpu.ready;
    if (kernel.trail) this.history = factory(kernel.trail * kernel.capacity * 16, `particles ${kernel.name} trail history`);
    if (deadList) {
      const usage = BUFFER.STORAGE | BUFFER.COPY_DST | BUFFER.COPY_SRC;
      this.dead = {
        list: device.createBuffer({ size: kernel.capacity * 4, usage, label: `particles ${kernel.name} dead list` }),
        count: device.createBuffer({ size: 16, usage, label: `particles ${kernel.name} counts` }),
        read: new GpuReadback(device, 16, `particles ${kernel.name} count read`),
      };
    }
    this.clear();
  }

  /** Index of the buffer holding the latest state. */
  get cur(): number {
    return this.state.cur;
  }

  step(uniforms: Float32Array, lut: Float32Array | null, parent: KernelRun | null): void {
    const d = this.device;
    d.queue.writeBuffer(this.uniforms, 0, uniforms.buffer, uniforms.byteOffset, this.kernel.uniformVec4 * 16);
    if (lut) d.queue.writeBuffer(this.lut, 0, lut.buffer, lut.byteOffset, Math.max(1, this.kernel.luts.length) * LUT_SAMPLES * 16);
    const p = parent instanceof WebGpuRun ? parent : null;
    const depthView = this.kernel.depth ? (this.depth?.view() ?? null) : null;
    if (this.kernel.depth && depthView !== this.lastDepth) {
      this.gpu.invalidate();
      this.lastDepth = depthView;
    }
    const group = this.gpu.group(`${this.state.cur}|${p ? `${p.cur}` : "-"}`, () => {
      const r: GpuResource[] = [
        { binding: 0, buffer: this.uniforms },
        { binding: 1, buffer: this.state.read },
        { binding: 2, buffer: this.state.write },
        { binding: 3, buffer: this.lut },
      ];
      if (this.kernel.event) r.push({ binding: 4, buffer: p ? p.current() : this.state.read });
      // Without a depth texture a 1×1 stand-in is bound; the kernel skips collision (ku[depth].z is 0).
      if (this.kernel.depth) r.push({ binding: 5, view: depthView ?? this.dummyDepth() });
      if (this.dead) r.push({ binding: 6, buffer: this.dead.list }, { binding: 7, buffer: this.dead.count });
      if (this.history) r.push({ binding: 8, buffer: this.history });
      return r;
    });
    const dead = this.dead;
    if (dead) d.queue.writeBuffer(dead.count, 4, ZERO_I32.buffer, 0, 4); // the alive count restarts each frame
    const dispatches: GpuDispatch[] = [{ entry: "main", items: this.kernel.capacity }];
    // A second dispatch (its own usage scope, so it sees the update's writes): pop free slots.
    if (dead) dispatches.push({ entry: "spawn", items: Math.min(this.kernel.capacity, Math.max(0, Math.floor(uniforms[U.spawn * 4 + 1]))) });
    let slot = -1;
    this.gpu.dispatch(group, dispatches, dead ? (enc) => (slot = dead.read.record(enc, dead.count)) : undefined);
    this.state.swap();
    // Read the alive count without waiting: it lands a frame or two later.
    if (dead && slot >= 0) dead.read.resolve(slot, (data) => (this.alive = new Int32Array(data.slice(0, 8))[1]));
  }

  private dummyView: unknown = null;
  private dummyDepth(): unknown {
    this.dummyView ??= this.device.createTexture!({ size: [1, 1], format: "r32float", usage: 0x04 }).createView();
    return this.dummyView;
  }

  /** The buffer the latest state is in (draws bind it). */
  current(): GpuBuffer {
    return this.state.read;
  }

  clear(): void {
    for (const b of this.state.both) this.device.queue.writeBuffer(b, 0, this.zeros.buffer, 0, this.zeros.byteLength);
    const dead = this.dead;
    if (dead) {
      // Every slot free, popped from the top so slots fill from 0 up.
      const cap = this.kernel.capacity;
      const list = new Int32Array(cap);
      for (let i = 0; i < cap; i++) list[i] = cap - 1 - i;
      this.device.queue.writeBuffer(dead.list, 0, list.buffer, 0, list.byteLength);
      this.device.queue.writeBuffer(dead.count, 0, new Int32Array([cap, 0, 0, 0]).buffer, 0, 16);
      this.alive = 0;
    }
  }

  /** Whether spawning uses a dead list (else the ring). */
  get deadList(): boolean {
    return this.dead !== null;
  }

  /** Read the latest state back (the parity tool, bench/particles; slow). */
  read(): Promise<Float32Array> {
    return readBuffer(this.device, this.current(), this.kernel.capacity * KERNEL_FLOATS * 4, "particles readback");
  }

  /** Read the trail history back, block by block like the JavaScript executor's (the parity tool; slow). */
  async readHistory(): Promise<Float32Array | null> {
    if (!this.history) return null;
    return readBuffer(this.device, this.history, (this.kernel.trail ?? 0) * this.kernel.capacity * 16, "particles history readback");
  }

  dispose(): void {
    if (this.dead) {
      this.dead.list.destroy();
      this.dead.count.destroy();
      this.dead.read.dispose();
    }
    for (const b of this.state.both) b.destroy();
    this.history?.destroy();
    this.uniforms.destroy();
    this.lut.destroy();
    this.gpu.dispose();
  }
}
